---
'harness-engineered-agentic-workflow': minor
---

- MCP tools on demand (`mcpTools`, default `auto`: above 20 tools): the project servers' tools are listed by name and the agent loads the ones it needs with `load_tools`, so their schemas are not sent with every call.
- A `beforeStop` check can pass with a `note`: the agent gets it once and gives its final answer with what the check found (the tester's verdict instead of "please check the page"); the checks run again only when files changed since. The `/setup` check skips the tester when only test files changed.
- A final message that announces more work ("Let me also run a quick check:") without a tool call is sent back once, instead of ending the run.
- In a run without a user, `start_plan` tells the agent to build directly, unless `finish_plan` is allowed in advance: a plan nobody can approve ended runs with nothing built.
