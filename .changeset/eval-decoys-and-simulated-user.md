---
'harness-engineered-agentic-workflow': minor
---

- Eval cases can have a simulated user (`user:` with `facts`, `stonewall` and `replies`): the judge's model answers the agent's questions as the person who asked for the task, giving a fact only when the agent asks about that decision. The new `disclosed: <id>` check passes when the agent asked for that fact. The agent in such a trial is told the user reads its answer (`EngineOptions.userReplies`); approvals are still denied.
