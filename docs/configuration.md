# Configuration reference

The quickest way to a working setup: `heaw`, then `/setup`. The agent asks about the project and writes these files with you, checks them with its `check_config` tool, and the chat applies them before your next message (also when you edit these files yourself; `/reload` applies them at once).

## `heaw.config.ts`

```ts
import { defineConfig, env } from 'harness-engineered-agentic-workflow';
export default defineConfig({ /* settings below */ });
```

| Setting | What it does | Default |
|---|---|---|
| `model` | `provider:model`, e.g. `azure:my-deployment` | — |
| `providers` | Provider settings by name; custom names need `type` (see below) | built-in env vars |
| `models` | Per model: `contextWindow`, `maxOutputTokens`, `pricing: { input, cacheRead, output }` (USD / 1M tokens) | catalog |
| `permissions` | `mode`, `allow`, `ask`, `deny` rules | `default`, no rules |
| `limits` | Per run: `maxTurns`, `maxTokens`, `maxCostUsd`, `maxMinutes` | 100 turns |
| `context.compactAt` | Compact at this share of the window, or `false` | `0.8` |
| `hooks` | Functions at fixed points (below); one set or an array | — |
| `verifyChanges` | Send the agent back once when it changed files and ran nothing since | `true` (off with a `beforeStop` hook) |
| `reasoningEffort` | `low`, `medium` or `high`, for models that reason; `/plan` uses `high` | provider default |
| `toolsets` | `fs`, `shell`, `web`, `todo`, `plan`, `http`, `mcp`, `agents`, `skills`, `memory` | all |
| `tools` | Your tools, made with `defineTool` | — |
| `mcpServers` | Same shape as `.mcp.json`; secrets with `env('NAME')` | — |
| `http.apis` | APIs for `http_request` by base URL: `{ headers, description }` | — |
| `subagents` | `maxDepth`, `maxParallel`, `limits`, `model` (for sub-agents whose agent file names none, e.g. a cheaper one), `minBudget` (the least share of the run's budget a sub-agent starts with) | `1`, `4`, 50 turns, the caller's model, $0.50 / 30,000 tokens |
| `workspace` | `type: 'local' \| 'docker'`, `shell`; Docker options below | local |
| `telemetry` | `endpoint`, `headers`, `serviceName`, `captureContent` | off |
| `sessions.save` | Save sessions in `.heaw/sessions/` | `true` |

**Providers.** Built in: `azure`, `openai`, `anthropic`, `google`, `ollama`. Fields: `type`, `apiKey`, `baseURL`, `endpoint` / `resourceName` (Azure), `api: 'responses' | 'chat'` (Azure), `headers`. Any OpenAI-compatible server: `{ type: 'openai-compatible', baseURL: 'http://localhost:1234/v1' }`.

**Local models.** Pick one that calls tools, such as `ollama:qwen3-coder:30b`, and give it an entry in `models`: `contextWindow`, and `pricing: { input: 0, output: 0 }` when a cost limit is set. Ollama serves 4,096 tokens of context by default, too little for the agent's instructions and tools: the model then writes tool calls as text. Set `OLLAMA_CONTEXT_LENGTH` (e.g. `32768`) in the environment Ollama starts in, and restart it. A model that cannot reason gets no reasoning effort after its first refusal, and a response the server cuts off is asked for again. On a desktop GPU a 30B model takes about a minute per turn: good for questions about the code, slow for building (heaw's eval comparison: [evals/README.md](../evals/README.md)).

**Docker workspace.** `{ type: 'docker', image: 'node:24', network: 'none' | 'bridge', cpus, memory, env: { NAME: env('NAME') }, git: { tokenEnv, username }, command: 'docker' | 'podman' }`. Only `env` reaches the container; `git.tokenEnv` enables HTTPS `git push`.

## Environment variables

| Variable | |
|---|---|
| `HEAW_MODEL` | Model when the config and flags set none |
| `HEAW_SHELL` | Shell for commands (Windows: Git Bash, else PowerShell) |
| `HEAW_HOME` | Personal folder (default `~/.heaw`) |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_BASE_URL` | Provider credentials |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | Traces (override `telemetry`) |

heaw reads `.env` from the project root.

## Permission rules

`tool` or `tool(pattern)`. Commands match with `*` (`run_command(npm *)`), paths as globs (`write_file(src/**)`), `web_fetch` by host (`web_fetch(*.python.org)`), `http_request` by method and origin, MCP tools by name (`mcp__github__get_*`).

Order: deny → approvals (`--allow`, "yes for the session") → protected files → ask → allow → mode. Protected files (`heaw.config.*`, `.mcp.json`, `.heaw/`, `.git/`) are always asked about.

For git commands that only read, allow `run_command(git status*)`, `run_command(git diff)` and `run_command(git diff -- *)`, not `git diff*`: `--output=<file>` writes a file, while after `--` everything is a path (`/setup` suggests these).

A command line is checked command by command (`npm run build && npm test`, `a; b`, `a | b`): a deny or ask rule that matches any of them applies, and allow rules allow the line only when each command is allowed. Output piped into `head`, `tail`, `grep`, `wc`, `cut` or `tr` needs nothing. A pattern never allows a command with `$(…)` or backticks; only a rule without one (`run_command`) does.

"Yes for the session" (**a**) allows the call, and also: after a file edit in `default` mode, all file edits (`accept-edits`); after a command, commands starting with the same words (`./mvnw -q test …`), for each command of a chained line. Shells, interpreters and destructive programs (`python`, `node`, `tsx`, `cross-env`, `docker`, `curl`, `rm`, …) are allowed only exactly, also behind `npx`, `npm exec` or `pnpm dlx`, and so is a line with one of them. The prompt shows what it allows.

## Hooks

| Hook | Can |
|---|---|
| `sessionStart` | Add context to the system prompt |
| `userPrompt` | Rewrite, add context to or block the prompt |
| `beforeModelCall` / `afterModelCall` | Change the request / log the answer |
| `beforeToolCall` | Block, change arguments, or allow without asking |
| `afterToolCall` | Add feedback to the result (e.g. lint errors) |
| `beforeStop` | Send the agent back with feedback; gets `editedFiles` |
| `beforeCompact` | Keep text through compaction |
| `subagentStart` / `subagentEnd` | Change or block a sub-agent's task / report |
| `sessionEnd` | Clean up, export |

Every hook gets `workspace` (run checks with `workspace.exec`), the session and agent ids, the model and a signal; `runAgent(name, task)` runs a named agent, e.g. a reviewer. Personal hooks run before project hooks. A failing `beforeToolCall` blocks the call; other failures are reported and skipped. When `beforeStop` returns the same feedback 3 times in a row (timings aside), the run stops with `check_failed`: the agent is stuck, or the check cannot run.

## Agents and skills

```markdown
---
name: reviewer
description: Reviews changes for bugs and missing tests.
tools: [read_file, grep]        # default: all of the caller's tools
mode: read-only                 # stricter than the caller, never looser; allow rules and "a" still apply
model: anthropic:claude-sonnet-4-5  # or inherit (the caller's); default: subagents.model, else the caller's
reasoningEffort: high           # low | medium | high; default: the config's
maxTurns: 30                    # also maxTokens, maxCostUsd, maxMinutes
mcpServers:                     # its own, as in .mcp.json: started on its first run, for it only
  browser:
    command: npx
    args: ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated", "--browser", "msedge"]
---
You are a careful reviewer. …
```

An agent's own MCP servers give it their tools besides `tools`, allowed for it without asking (a deny rule still applies); the other agents never see them, so two dozen browser tools cost the main agent nothing. `/setup` offers such a `tester` for web apps: it starts the app, uses the changed pages in a browser and ends with "Verdict: works", "fix first" or "could not test"; the `beforeStop` hook runs it after interface changes, and plan steps that change the interface are checked with it.

Agents: `.heaw/agents/<name>.md` (Claude Code agent files work). The agent gives each sub-agent its `files` (its other writes are denied) and a `check` it must pass before it reports. Sub-agents started together share what the run's budget has left, and near 80% of a limit (turns, tokens, cost or time) the agent is asked to wrap up. Skills: `<name>/SKILL.md` with `name` and `description` in `.heaw/skills/`, `.agents/skills/` or `.claude/skills/`; personal ones in `~/.heaw/`. Built in: `setup-harness` (`/setup`), `plan-work` (`/plan`) and `retro` (`/retro [session]`: the agent reviews a session with its `session_report` tool and proposes lasting fixes).

## MCP

```bash
heaw mcp search jira                                   # official MCP Registry
heaw mcp install com.atlassian/atlassian-mcp-server
heaw mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
heaw mcp add docs --url https://example.com/mcp --header "Authorization: Bearer \${DOCS_TOKEN}"
heaw mcp list | test <name> | login <name> | logout <name> | remove <name>
```

Tools appear as `mcp__<server>__<tool>` and ask before running unless allowed. Logins are kept in `~/.heaw/credentials/mcp/`.

## Tracing

```bash
docker run -d -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 heaw run "…"      # http://localhost:16686
```

Spans per run, model call and tool call (GenAI conventions), with tokens, cost and links to commits and PRs. `captureContent: true` adds prompts and outputs. Values of secret-looking variables (`*_KEY`, `*_TOKEN`, …) and of every variable the config reads are redacted from logs and traces.

## heaw in Docker

```bash
docker build -t heaw .
docker run -it --rm -v "$PWD:/workspace" --env-file .env heaw
```
