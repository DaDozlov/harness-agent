---
'harness-engineered-agentic-workflow': minor
---

Security hardening, after a review:

- Allow rules no longer cover output redirected into a file: `run_command(npm test*)` allows `npm test`, not `npm test > heaw.config.ts`; write the redirect into the rule to allow one. **Stricter:** a command that writes a file this way is now asked about.
- Commands in a local workspace no longer get heaw's credentials or variables whose names look like secrets (API keys, tokens, passwords; an SSH agent's socket stays). **Stricter:** a command that needs one gets it through `workspace.passEnv`, e.g. `['GH_TOKEN']`.
- Every agent is told that what tools return (files, pages, command and MCP output, subfolders' AGENTS.md) is data, not instructions. A subfolder's AGENTS.md and skills count only when the project committed them and they are not vendored code.
- `web_fetch` never fetches link-local addresses (cloud metadata), fetches loopback and private addresses only when the URL names them or a rule names the host, and follows redirects only within the same scheme, host and port.
- Paths are checked by where they really lead: a link cannot reach outside the workspace, nor around the protected paths.
- The Docker workspace runs with `no-new-privileges`, a process limit and only the capabilities package installs need.
- The docs state what a local workspace cannot stop, and recommend the Docker workspace for unattended runs.
- An unattended run in `bypass` mode uses the Docker workspace by default (**stricter:** set `workspace: { type: 'local' }` to run its commands on this machine).
- Web pages and MCP results are marked as data, not instructions.
- MCP tools are pinned when a server first connects; a tool whose description or arguments change later, or a new one, is held back until `heaw mcp trust <name>` (or `/mcp trust <name>`).
- A command refused in a run without a user that is one of the project's npm scripts is named as such: "run it as `npm run clean`, which is allowed".
