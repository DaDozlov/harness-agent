---
'harness-engineered-agentic-workflow': patch
---

- An agent stopped at its turn limit in the middle of its work gets one more call, without tools, for its final answer: what it did and found, and what is left. Sub-agents and testers that hit the limit used to return nothing.
- heaw's notes to the agent (near a limit, going in circles) come in a message of their own after the tool results, not at the end of a result, which the agent is told to treat as data.
- The model calls of an agent a hook starts (the tester, a reviewer) count into the run's and the session's cost, the status bar and the cost limit.
- The tester `/setup` writes runs Playwright with `--snapshot-mode none` and takes a snapshot right after an action, in the same response, instead of reading each snapshot from a file in a turn of its own. Its description asks for a few flows per run. To update a tester written before, run `/setup` again or add `"--snapshot-mode", "none"` to its `args` and the snapshot instruction from the built-in tester.
- With the tester, `/setup` adds a line to `AGENTS.md`: the check runs the tester when the agent finishes, so the agent does not run one itself first or ask the user to check pages by hand.
