---
'harness-engineered-agentic-workflow': patch
---

- heaw stops commands that an earlier heaw left running when it ended without stopping them (the terminal closed, the process killed), such as a dev server that keeps its port, and says so when it starts. It stops only processes it can tell are the ones it started: by their marker in Git Bash, otherwise by process id and start time. Running commands are noted in `~/.heaw/processes/` while they run.
