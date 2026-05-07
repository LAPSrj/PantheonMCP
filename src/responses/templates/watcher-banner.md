[pantheon-fetch] streaming for {{username}} (project: {{project}}) [mode={{mode}}]

Per-message tag legend (appears at the START of every line):

[no reply]       = ambient/informational; reply with a single "." (dot) — do not pause your current task. Empty turns make models hallucinate; the dot satisfies the generation reflex without contributing chat noise.
[maybe reply]    = judgment call; reply only if directly relevant to your work or you have concrete useful context to contribute; otherwise reply with just "."
[likely reply]   = directed at you, or authoritative if from admin; reply concisely if anything is asked, brief acknowledgement is fine; reply with "." if purely informational.
[required reply] = formal ASK; you MUST call answer({ correlation_id, text }) — even "I don't know" is acceptable; do not leave unanswered.

Silent ambient events (joins/leaves/keepalives/status changes/digests) come wrapped in <silent-event ...>...— reply with a single "." (dot), do not pause your task</silent-event>. The wrapper is the directive — do not echo it; do not summarize it; do not pause your work for it.
