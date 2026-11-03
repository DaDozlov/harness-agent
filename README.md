# heaw — harness-engineered agentic workflow

An open-source **agent harness** for TypeScript: bring any model (OpenAI, Azure OpenAI, Anthropic, Google, Ollama, any OpenAI-compatible endpoint) and get the agent loop, tools, MCP, permissions, hooks, sub-agents, skills, memory, sessions, evals and tracing, as a CLI (`heaw`) and a library. Each project configures its harness in files next to its code.

- **Safe**: asks before writing, running commands or using the network; rules, modes, limits and a Docker sandbox; cannot change its own guardrails; `/rewind` undoes a run.
- **Verified**: hooks run your checks before the agent may finish; evals measure success rates; sessions link to the commits and PRs they produced; OpenTelemetry traces.
- **Connected**: any MCP server (with OAuth), your HTTP APIs, your own tools.

## Install

Requires Node.js 22.12+. Until the first npm release, install from source:

```bash
git clone https://github.com/DaDozlov/harness-agent.git && cd harness-agent
npm install && npm run build && npm link     # later: npm install -g harness-engineered-agentic-workflow
```

## Quick start

```bash
cd my-project
heaw init --model azure:my-deployment   # heaw.config.ts, AGENTS.md, .env.example
cp .env.example .env                    # add your credentials
heaw                                    # chat
heaw run --mode accept-edits --allow "run_command(npm test*)" "Fix the failing test"
```

## Commands

| Command | |
|---|---|
| `heaw` · `heaw -c` · `heaw resume [id]` | Chat · continue the last chat · resume a saved one |
| `heaw run "<task>"` | One-shot run for scripts and CI (`--json` for raw events) |
| `heaw init` | Create the project files |
| `heaw models` | Selected model, its context, capabilities and price |
| `heaw sessions` | Saved sessions with intent, cost, commits and PRs |
| `heaw mcp search\|install\|add\|list\|test\|login\|remove` | Manage MCP servers |
| `heaw eval [filter]` · `eval add` · `eval compare` | Run evals · case from a session · compare reports |

Agent flags (chat, `run`, `resume`, `eval`): `--model`, `--mode`, `--allow <rule>`, `--deny <rule>`, `--max-turns`, `--max-cost`, `--max-minutes`, `--intent`, `--no-tools`, `--no-save`.

**In the chat:** Enter sends, `\`+Enter adds a line, Esc interrupts, Shift+Tab switches mode, Ctrl+C twice exits. Approvals: **y** yes · **a** yes for the session · **n** no · **f** no with feedback. Commands: `/help` `/clear` `/model` `/mode` `/tools` `/mcp` `/permissions` `/cost` `/compact` `/rewind` `/agents` `/skills` `/exit`.

## Configure a project

| File | Purpose |
|---|---|
| `heaw.config.ts` | Model, permissions, limits, hooks, workspace, MCP, APIs ([all settings](docs/configuration.md)) |
| `AGENTS.md` | Instructions for the agent; subfolders can have their own |
| `.mcp.json` | MCP servers, in the usual format; `${VAR}` reads the environment |
| `.heaw/agents/*.md` | Named sub-agents |
| `.heaw/skills/*/SKILL.md` | Skills, loaded on demand (`.agents/skills/` and `.claude/skills/` work too) |
| `.heaw/memory.md` | Notes the agent saved with `remember` |
| `evals/*.yaml` | Eval cases ([docs/evals.md](docs/evals.md)) |

```ts
import { defineConfig, env } from 'harness-engineered-agentic-workflow';

export default defineConfig({
  model: 'azure:gpt-5.4',
  permissions: {
    mode: 'accept-edits',                     // default · accept-edits · read-only · bypass
    allow: ['run_command(npm test*)'],
    deny: ['read_file(**/.env*)'],
  },
  limits: { maxTurns: 100, maxCostUsd: 5 },
  hooks: {
    // The agent may only finish a run that changed files once the tests pass.
    async beforeStop({ workspace, editedFiles }) {
      if (!editedFiles.length) return;
      const tests = await workspace.exec('npm test', { timeoutMs: 600_000 });
      if (tests.exitCode !== 0) return { continue: true, feedback: tests.output.slice(-4_000) };
    },
  },
  // workspace: { type: 'docker', network: 'bridge', env: { GH_TOKEN: env('GITHUB_TOKEN') } },
});
```

Credentials stay in `.env` (`env('NAME')`). Personal defaults go in `~/.heaw/` (same files). Precedence: flags > `HEAW_MODEL`/`HEAW_SHELL` > project > personal; permission rules add up. Restart heaw after changing config (`/mcp reload` for MCP servers).

## Permissions

| Mode | Write | Commands | Network |
|---|---|---|---|
| `default` | ask | ask | ask |
| `accept-edits` | ✅ | ask | ask |
| `read-only` | ❌ | ❌ | ask |
| `bypass` | ✅ | ✅ | ✅ |

- Rules: `tool` or `tool(pattern)`, e.g. `run_command(git *)`, `write_file(src/**)`, `mcp__github__*`, `http_request(GET https://api.example.com)`. Deny wins; `ask` beats `allow`.
- In `heaw run` nobody can approve, so "ask" means denied unless `--allow` names the call.
- `heaw.config.*`, `.mcp.json`, `.heaw/` and `.git/` are always asked about, even in `bypass`.

## What else is built in

| Feature | How |
|---|---|
| Verification | `beforeStop` / `afterToolCall` hooks; `runAgent()` in hooks for a reviewer. Without hooks, an agent that changed files and ran nothing is sent back once to check (`verifyChanges: false` to turn off) |
| Sub-agents | `delegate` to `.heaw/agents/<name>.md` or a general agent; never more tools or rights than the caller |
| Skills | Index in the prompt, full text via `load_skill` |
| Memory | `remember` saves a note to `.heaw/memory.md` (asked each time); later sessions read it |
| Context | Auto-compaction at 80% of the window; `/compact`; `/cost` shows where tokens go |
| Undo | `/rewind [n]` restores files the last runs changed (file tools only) |
| Sessions | Saved in `.heaw/sessions/`, resumable; linked to commits and PRs; `--intent build` labels them |
| Docker | `workspace: { type: 'docker' }`: commands run in a container, heaw's files read-only |
| Evals | `heaw eval`, `eval add --from-session <id>`, `--compare latest` ([docs/evals.md](docs/evals.md)) |
| Tracing | `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, GenAI conventions; secrets redacted from logs and traces |

## Library

```ts
import { createProjectEngine } from 'harness-engineered-agentic-workflow';

const engine = await createProjectEngine();             // as `heaw run` would set it up
const result = await engine.runAgent('main', 'Implement PROJ-123', {
  allow: ['run_command(git push -u origin HEAD)'],
});
await engine.dispose();
```

`createEngine()` builds one in code; `engine.session().send()` streams events and approvals. See [examples/library](examples/library/).

## Examples

[GitHub + Jira](examples/github-jira/) (story → pull request) · [Coding agent](examples/coding-agent/) (hooks + evals) · [Customer support](examples/business-agent/) (API + skills, no shell) · [Library](examples/library/).

## Development

```bash
npm install
npm run check    # typecheck, lint, architecture rules, formatting, tests
npm run build
```

Docker tests run when Docker is available. Design: [docs/DESIGN.md](docs/DESIGN.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · License: [MIT](LICENSE)
