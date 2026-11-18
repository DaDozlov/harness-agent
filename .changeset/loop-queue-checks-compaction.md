---
'harness-engineered-agentic-workflow': minor
---

- A message typed while heaw works is queued instead of refused: the agent gets it before its next model call, or before it would finish, and the run takes it into account (`Session.queue`, event `input.delivered`).
- The checks before finishing can send the agent back at most 5 times in one run, whatever they report; then the run stops with the new stop reason `check_limit` and the user sees their last report.
- Compaction summaries also keep approaches ruled out (with why), what was verified apart from what is assumed, and changes started but not finished.
- The agent is told that what another system expects (the format of a file it imports, an API it calls) is a decision for the user when neither the request nor the project shows it, and asks instead of copying a format from other code.
- An MCP server that stops while connected is connected again after 2, 10 and 30 seconds before heaw gives up, and the agent is told which of the project's servers are down and why.
- Editing an existing lint or format config, a CI workflow or a pre-commit setup is asked about in `default` and `accept-edits` mode (`CHECK_FILES`), so the agent fixes the code instead of weakening the check. Creating one is free; an allow rule naming the file lets edits through.
- Deny and ask rules can carry a hint, `{ rule: 'run_command(npm install*)', hint: 'This project uses pnpm: run pnpm install.' }`, which the agent gets with the refusal.
- Loading a project warns when `AGENTS.md`, an agent file, a skill or the memory contains invisible characters (zero-width, bidirectional controls, Unicode tags) that the agent reads and you do not see.
- The chat rings the terminal bell when an approval has waited 3 seconds and when a run of 30 seconds or more ends; `HEAW_BELL=off` turns it off.
- The chat asks once per folder before it loads a project whose `heaw.config.*` or `.mcp.json` would run code ("Trust this folder?"), and remembers the answer in `~/.heaw/trusted-projects.json`. `heaw init` trusts the folder it sets up; `heaw run` does not ask.
