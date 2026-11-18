---
'harness-engineered-agentic-workflow': minor
---

- Eval cases can send follow-up messages (`followUps:`), each once the run before has finished, to grade whether later work builds on earlier work.
- `heaw eval --without <guard>` switches a guard off in every trial (`verify-reminder`, `unfinished-nudge`), to compare with a run that has it; the report records which were off. `EngineOptions.nudgeUnfinished: false` switches off the nudge for unfinished answers.
