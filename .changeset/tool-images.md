---
'harness-engineered-agentic-workflow': minor
---

Tools can return images, such as a screenshot from Playwright's MCP server: models that can see get them through the OpenAI Responses API (also Azure's) and Anthropic, others a description. Only the three latest results keep their images, and saved sessions keep only the description. The tester `/setup` writes looks at screenshots of the changed pages, wide and narrow, to find layout problems, and keeps Playwright's files in `.heaw/tester/`.
