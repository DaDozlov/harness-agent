---
'harness-engineered-agentic-workflow': minor
---

- Eval cases can add deny rules (`deny`), bring the fixture's own agents (`agents: true`) and give the model a smaller context window (`contextWindow`); the new checks `called: <tool>` and `compactions: <n>` show that a case tested what it is about.
- An agent a hook runs (a tester or reviewer in `beforeStop`) shows in the chat and the session log, with the last line of its answer: `ui-tester: Verdict: works`.
- `glob` and `grep` find hidden files when the pattern or path names them (`.heaw/**`, `.github/**`), so `/setup` no longer misses existing agents and CI files.
- `/setup` keeps the comments and settings already in `heaw.config.ts`, names the browser tester `ui-tester` when a `tester` with another job exists, and checks for Edge or Chrome where they are installed rather than on the PATH. The tester checks the change first, at both widths, within about 25 steps.
