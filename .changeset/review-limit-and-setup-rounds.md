---
'harness-engineered-agentic-workflow': patch
---

- Agent files take `maxRuns`: how often `delegate` may start the agent per message. The reviewer `heaw init` writes has `maxRuns: 2`; a third round is refused with a note to fix what is must-fix and list the rest. Add `maxRuns: 2` to a reviewer written before.
- `/setup` asks in three rounds instead of one topic per message: the project and its stack, then the toolchain checked and everything else in one numbered message, then the files.
- Sessions an agent of a hook ran (the tester in `beforeStop`) are saved with the conversation that ran them and left out of `heaw sessions`, the picker and the latest session to resume or review. They still load by id.
- `session_report` (for `/retro`) counts a check that passed with findings apart from checks that sent the agent back.
