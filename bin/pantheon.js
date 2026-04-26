#!/usr/bin/env node
import { runMcpServer } from "../src/mcp/server.ts";

runMcpServer().catch((err) => {
  // stdio transport: the daemon must NOT pollute stdout (it's the MCP
  // wire). Surface fatal errors on stderr and exit non-zero.
  process.stderr.write(
    `pantheon: fatal: ${(err && (err as Error).message) ?? String(err)}\n`,
  );
  process.exit(1);
});
