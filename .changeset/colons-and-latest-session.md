---
'harness-engineered-agentic-workflow': patch
---

- The chat shows colons in the inline code of list items, which showed as `*#COLON|*` (a rule such as `run_command(curl … http://localhost:*)` was unreadable).
- `heaw eval add <name> --from-session` without an id takes the latest conversation and names it.
