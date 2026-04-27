// Minimal markdown renderer for terminal output (admin console UX
// parity with chat-mcp/src/markdown.ts).
//
// Supports:
//   Block:  fenced code blocks (```), ATX headings (# .. ######),
//           unordered lists (-, *, +) and ordered lists (1.),
//           blockquotes (> ...)
//   Inline: **bold**, _italic_, `code`, [text](url) with OSC 8 hyperlinks
//
// Styles can nest (e.g. `code` inside **bold**) — close codes are scoped to
// the attribute so the outer style survives.

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const UL_ON = "\x1b[4m";
const UL_OFF = "\x1b[24m";
const CODE_ON = "\x1b[36m"; // cyan
const CODE_OFF = "\x1b[39m";
const GREY = "\x1b[90m";
const FG_RESET = "\x1b[39m";
const RESET = "\x1b[0m";

const osc8Open = (url: string): string => `\x1b]8;;${url}\x07`;
const OSC8_CLOSE = "\x1b]8;;\x07";

const STYLE_PAIRS: Array<[string, string]> = [
  [BOLD_ON, BOLD_OFF],
  [ITALIC_ON, ITALIC_OFF],
  [UL_ON, UL_OFF],
  [CODE_ON, CODE_OFF],
];

const SGR_RE_ANCHORED = /^\x1b\[[0-9;]*m/;
const OSC8_RE_ANCHORED = /^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
const ANSI_RE_GLOBAL =
  /\x1b\[[0-9;]*m|\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function renderMarkdownBlock(text: string, width: number): string {
  const w = Math.max(1, width);
  const blocks = parseBlocks(text);
  const out: string[] = [];
  for (const b of blocks) {
    for (const line of renderBlock(b, w)) out.push(line);
  }
  return out.join("\n");
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE_GLOBAL, "");
}

type Block =
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; indent: number; marker: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "para"; text: string };

function parseBlocks(text: string): Block[] {
  const rawLines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i]!;

    const fenceOpen = line.match(/^\s*```(.*)$/);
    if (fenceOpen) {
      const lang = fenceOpen[1]!.trim();
      const code: string[] = [];
      i++;
      while (i < rawLines.length && !/^\s*```\s*$/.test(rawLines[i]!)) {
        code.push(rawLines[i]!);
        i++;
      }
      if (i < rawLines.length) i++;
      out.push({ kind: "code", lang, lines: code });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (list) {
      out.push({
        kind: "list",
        indent: list[1]!.length,
        marker: list[2]!,
        text: list[3]!,
      });
      i++;
      continue;
    }

    // Blockquotes: `>`-prefixed lines, optional space after the
    // marker. Consecutive quote lines fold into one block. Empty
    // `>` lines render as a blank line within the quote.
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const lines: string[] = [quote[1]!];
      i++;
      while (i < rawLines.length) {
        const m = rawLines[i]!.match(/^>\s?(.*)$/);
        if (!m) break;
        lines.push(m[1]!);
        i++;
      }
      out.push({ kind: "quote", lines });
      continue;
    }

    out.push({ kind: "para", text: line });
    i++;
  }
  return out;
}

function renderBlock(b: Block, width: number): string[] {
  switch (b.kind) {
    case "code":
      if (b.lines.length === 0) return [""];
      return b.lines.map((l) => CODE_ON + l + CODE_OFF);

    case "heading": {
      const style = b.level === 1 ? BOLD_ON + UL_ON : BOLD_ON;
      const close = b.level === 1 ? UL_OFF + BOLD_OFF : BOLD_OFF;
      return wrapAnsi(style + renderInline(b.text) + close, width);
    }

    case "list": {
      const isOrdered = /^\d+\./.test(b.marker);
      const bullet = isOrdered ? b.marker : "•";
      const indentStr = " ".repeat(b.indent);
      const prefixVisible = indentStr + bullet + " ";
      const prefix = indentStr + GREY + bullet + FG_RESET + " ";
      const hang = " ".repeat(prefixVisible.length);
      const contentWidth = Math.max(1, width - prefixVisible.length);
      const wrapped = wrapAnsi(renderInline(b.text), contentWidth);
      return wrapped.map((l, idx) => (idx === 0 ? prefix + l : hang + l));
    }

    case "quote": {
      // Render each quoted line with a grey vertical-bar prefix and
      // a dim body. Inline markdown still renders inside the quote
      // (links, code, bold, italic). The bar is `▌ ` (LEFT HALF
      // BLOCK + space) — a single visible cell + separator. Width
      // budget for the body is `width - 2` so a long line wraps
      // cleanly with the bar still in front of every wrapped row.
      const BAR = GREY + "▌ " + FG_RESET; // "▌ "
      const DIM_ON = "\x1b[2m";
      const DIM_OFF = "\x1b[22m";
      const contentWidth = Math.max(1, width - 2);
      const out: string[] = [];
      for (const ql of b.lines) {
        if (ql.trim() === "") {
          out.push(BAR);
          continue;
        }
        const wrapped = wrapAnsi(DIM_ON + renderInline(ql) + DIM_OFF, contentWidth);
        for (const w of wrapped) out.push(BAR + w);
      }
      return out;
    }

    case "para": {
      if (!b.text.trim()) return [""];
      return wrapAnsi(renderInline(b.text), width);
    }
  }
}

function renderInline(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, t, url) => {
      return (
        osc8Open(url) + UL_ON + CODE_ON + t + CODE_OFF + UL_OFF + OSC8_CLOSE
      );
    })
    .replace(/`([^`\n]+)`/g, (_m, b) => CODE_ON + b + CODE_OFF)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_m, b) => BOLD_ON + b + BOLD_OFF)
    .replace(
      /(^|[\s([{,;:])_(?=\S)([^_\n]*?\S)_(?=[\s)\]},.;:!?]|$)/g,
      (_m, pre, b) => pre + ITALIC_ON + b + ITALIC_OFF,
    );
}

export function wrapAnsi(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    wrapParagraph(para, width, out);
  }
  return out;
}

function wrapParagraph(text: string, width: number, out: string[]): void {
  const w = Math.max(1, width);
  const active = new Set<string>();
  let activeLink: string | null = null;

  let line = "";
  let vis = 0;
  let lastSpaceIdx = -1;
  let lastSpaceActive: string[] = [];
  let lastSpaceLink: string | null = null;

  const trailerFor = (arr: string[], link: string | null): string => {
    let s = "";
    if (arr.length) s += RESET;
    if (link !== null) s += OSC8_CLOSE;
    return s;
  };
  const headerFor = (arr: string[], link: string | null): string => {
    let s = "";
    if (link !== null) s += osc8Open(link);
    for (const on of arr) s += on;
    return s;
  };

  let i = 0;
  while (i < text.length) {
    const tail = text.slice(i);

    const osc8 = tail.match(OSC8_RE_ANCHORED);
    if (osc8) {
      const seq = osc8[0];
      const url = osc8[1]!;
      line += seq;
      activeLink = url.length > 0 ? url : null;
      i += seq.length;
      continue;
    }

    const sgr = tail.match(SGR_RE_ANCHORED);
    if (sgr) {
      const seq = sgr[0];
      line += seq;
      updateActive(active, seq);
      i += seq.length;
      continue;
    }

    const ch = text[i]!;
    line += ch;
    if (ch === " ") {
      lastSpaceIdx = line.length - 1;
      lastSpaceActive = Array.from(active);
      lastSpaceLink = activeLink;
    }
    vis++;
    i++;

    if (vis > w) {
      if (lastSpaceIdx >= 0) {
        const head = line.slice(0, lastSpaceIdx);
        const rest = line.slice(lastSpaceIdx + 1);
        out.push(head + trailerFor(lastSpaceActive, lastSpaceLink));
        line = headerFor(lastSpaceActive, lastSpaceLink) + rest;
        vis = visibleLen(rest);
        lastSpaceIdx = -1;
      } else {
        const snapActive = Array.from(active);
        out.push(line + trailerFor(snapActive, activeLink));
        line = headerFor(snapActive, activeLink);
        vis = 0;
        lastSpaceIdx = -1;
      }
    }
  }
  out.push(line + trailerFor(Array.from(active), activeLink));
}

function updateActive(active: Set<string>, seq: string): void {
  if (seq === RESET) {
    active.clear();
    return;
  }
  for (const [on, off] of STYLE_PAIRS) {
    if (seq === on) {
      active.add(on);
      return;
    }
    if (seq === off) {
      active.delete(on);
      return;
    }
  }
}

function visibleLen(s: string): number {
  return s.replace(ANSI_RE_GLOBAL, "").length;
}
