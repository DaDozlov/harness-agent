# harness-engineered-agentic-workflow — Design (v1)

> Status: **v1 built** (M0–M9 done). The doc describes the harness as built; decisions made while building are recorded in the sections and in §13.
> Package: `harness-engineered-agentic-workflow` · CLI: `heaw` · License: MIT

## 1. What this is

A reusable, open-source **agent harness** for TypeScript. The harness is everything around the language model that turns it into an agent: the agent loop, tools, context management, permissions, hooks, sub-agents, sessions and observability.

- **The model is pluggable.** Pick any supported provider (OpenAI, Azure OpenAI, Anthropic, Google, Ollama, any OpenAI-compatible endpoint such as Mistral or OpenRouter) by config. Credentials come from environment variables.
- **The harness is stable.** It is installed as an npm package and upgraded by version bump — never copied and edited.
- **Projects extend it** through defined extension points: tools, MCP servers, instructions, skills, hooks, agent definitions and permission rules. `heaw init` scaffolds this project layer.

### Goals (v1)

1. Interactive **CLI chat** (`heaw`) and non-interactive runs (`heaw run`) for scripts and CI.
2. Works for **coding** (files, shell, git) and **business** work (APIs, documents, data) — the difference is configuration, not code.
3. **Provider-agnostic** through one internal model interface.
4. **Safe by default**: read freely, ask before writing, executing or calling the network.
5. **Single agent + sub-agents** (named and ad-hoc) with strict limits.
6. Runs **locally** or with tool execution inside **Docker**.
7. Usable as a **library**: the CLI is just one consumer of the engine's event stream, so a web UI can be added later without engine changes.

### Non-goals (v1) — see [Roadmap](#12-roadmap-after-v1)

Web UI, cloud sandboxes, agent teams/handoffs, parallel tasks in separate git worktrees, long-term memory, OS-level sandboxing, JSON/YAML config, exposing the agent as an MCP server.

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Engine** | The runtime that executes agents. One engine can run many agents. |
| **Agent definition** | Data, not code: model, instructions, tool list, permission overrides, limits. |
| **Model client** | Our interface to an LLM. Implemented by provider adapters. |
| **Tool** | A typed function the model can call. Grouped into **toolsets** (`fs`, `shell`, …). |
| **MCP server** | External tool provider over the Model Context Protocol; its tools appear as normal tools. |
| **Instructions** | Layered system prompt: harness base → global → project `AGENTS.md` → agent definition. |
| **Skill** | A folder with `SKILL.md`; only name + description sit in context, full content is loaded on demand. |
| **Hook** | Project code that runs at fixed lifecycle points and can block, modify or add feedback. |
| **Workspace** | Where tools act: files and command execution. `local` or `docker`. |
| **Permission policy** | Rules deciding allow / ask / deny for every tool call. |
| **Session** | One conversation: an append-only event log that can be resumed. |
| **Event** | Everything the engine does is emitted as a typed event; UIs and loggers consume them. |

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ CONSUMERS      CLI chat (Ink) · heaw run · library users ·   │
│                (later) web UI                                │
│                      ▲ events            │ input/approvals   │
├──────────────────────┼───────────────────▼───────────────────┤
│ PROJECT LAYER  heaw.config.ts · AGENTS.md · .heaw/agents ·   │
│                .heaw/skills · custom tools · hooks · evals   │
├──────────────────────────────────────────────────────────────┤
│ BATTERIES      toolsets (fs, shell, web, http, todo, agents, │
│                skills) · MCP client · workspaces (local,     │
│                docker) · tracing · eval runner               │
├──────────────────────────────────────────────────────────────┤
│ CORE           agent loop · messages · events · tool         │
│                registry · context manager · permission       │
│                engine · hook bus · session store · agent     │
│                registry · model client interface             │
├──────────────────────────────────────────────────────────────┤
│ PROVIDERS      AI SDK adapter (OpenAI, Azure, Anthropic,     │
│                Google, Ollama, OpenAI-compatible …) · model  │
│                catalog · scripted provider (tests)           │
└──────────────────────────────────────────────────────────────┘
```

**Dependency rule:** `core` imports nothing from `providers`, `tools`, `mcp`, `workspace` or `cli` — only interfaces. Enforced in CI with dependency-cruiser. This keeps the core small, testable and replaceable at the edges.

## 4. Components

### 4.1 Agent loop

```
run(input):
  emit run.start; hooks.userPrompt(input); history.append(user(input))
  loop:                                         # one iteration = one turn
    if limits exceeded (turns, tokens, cost, time) or aborted → stop(reason)
    emit turn.start
    context.prepare(history)                  # truncate / compact if near the window
    response = model.stream(request)          # emits text/reasoning deltas
    history.append(assistant(response))
    if response has no tool calls:
      verdict = hooks.beforeStop()            # e.g. run tests; may push feedback
      if verdict.continue: history.append(user(verdict.feedback)); continue
      break
    results = executeToolCalls(response.toolCalls)
    history.append(toolResults(results))
  emit run.end(usage, stopReason, turns)
```

Terms: a **run** handles one user input; a **turn** is one model call plus the tool calls it requested.

**Limits** apply per run, each with its own stop reason: `maxTurns` (default 100, `max_turns`), `maxTokens` (input plus output, summed over the run's model calls, `token_limit`), `maxCostUsd` (`cost_limit`) and `maxMinutes` (wall clock, approvals included, `time_limit`). Turn, token and cost limits are checked before each turn; the time limit aborts the run like Esc, so running tools stop too. A cost limit needs the model's price: without one, the engine refuses to start (and `/model` refuses to switch), since the limit could never trigger.

Tool call execution, per call:

1. Validate arguments against the tool's schema → on failure, return the validation error to the model (it can fix and retry).
2. Permission check → allow / deny / **ask** (emits `approval.request`, waits for the consumer).
3. `beforeToolCall` hooks → may block or rewrite arguments.
4. Execute with an `AbortSignal` and timeout.
5. Truncate oversized output (§4.9).
6. `afterToolCall` hooks → may append feedback (e.g. lint errors after an edit).

Rules:

- **Tool errors are results, not exceptions.** Exceptions become error tool results so the model can recover.
- **Concurrency:** tools declare `parallel` or `serial`. Default: read tools and `delegate` run in parallel; write/execute tools run serially in the order the model gave.
- **Abort:** Esc/Ctrl+C aborts the model stream and running tools; partial output is recorded.
- **Provider errors** (429, 5xx, network) are retried with exponential backoff, honoring `retry-after`, but only while nothing has streamed yet. A failure mid-answer ends the run with an error, so the user never sees output twice. A response cut off half way (the stream ends without a finish reason, or the connection drops) counts as retryable: a local Ollama model cut off while it was writing a tool call (which streams no text) ended an eval trial after nine minutes of work.
- **Going in circles** (`core/stuck.ts`): agents stuck on a problem make small variations of the same broken fix, ten times and more. Two signals catch it within a run: a call that fails the same way three times (same tool and command, same output without timings), and a file that goes back to content it had earlier in the run for the second time (an edit, its undo, the edit again; by content hash). The agent is told once per signal, on that call's result, to step back, find the cause and try a different approach or stop and report; a `stuck` event tells the user. Edit counts per file would not do: one fix can rightly take many edits of one file.
- **Thinking harder** where it pays: on models that reason, the call after a `beforeStop` check sent the agent back, or after it was told it is going in circles, uses `high` effort; the others use the configured one. Finding why something fails gains more from reasoning than writing code does (LangChain measured high effort for planning and verification and medium for the rest above high everywhere).

### 4.2 Messages and events

Internal message types are our own (provider-neutral):

```ts
type Message =
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; content: ContentPart[] }           // text, reasoning, tool-call
  | { role: 'tool'; content: ToolResultPart[] };

type ContentPart = TextPart | ImagePart | ReasoningPart | ToolCallPart;
```

Events (discriminated union, every event carries `sessionId`, `agentId`, `parentAgentId?`, `timestamp`):

```ts
type EngineEvent =
  | { type: 'run.start'; input: string }
  | { type: 'run.end'; stopReason: StopReason; usage: Usage; turns: number }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; text: string } | { type: 'reasoning.delta'; text: string }
  | { type: 'message.complete'; message: Message }
  | { type: 'tool.start'; callId: string; tool: string; args: unknown }
  | { type: 'tool.progress'; callId: string; data: unknown }
  | { type: 'tool.end'; callId: string; tool: string; output: string;
      status: 'ok' | 'error' | 'denied' | 'cancelled'; isError: boolean; durationMs: number }
  | { type: 'approval.request'; requestId: string; callId: string; tool: string; args: unknown;
      subject?: string; reason: string }
  | { type: 'approval.response'; requestId: string; decision: ApprovalDecision }
  | { type: 'subagent.start'; childAgentId: string; name: string; task: string; callId?: string } // callId: the delegate call
  | { type: 'subagent.end'; childAgentId: string; name: string; stopReason: StopReason;
      turns: number; usage: Usage; costUsd?: number }        // the report is the delegate result
  | { type: 'compaction'; trigger: 'auto' | 'manual'; method: 'tool-results' | 'summary';
      beforeTokens: number; afterTokens: number }
  | { type: 'hook'; hook: HookName; message: string }        // a hook blocked or redirected
  | { type: 'usage'; usage: Usage; costUsd?: number }        // one model call
  | { type: 'limit.near'; limit: 'turns' | 'tokens' | 'cost' | 'time'; used: number; max: number } // 80%: asked to wrap up
  | { type: 'stuck'; signal: 'same-failure' | 'back-and-forth'; subject: string; count: number } // told to step back
  | { type: 'error'; error: SerializedError; recoverable: boolean };
```

`run.end` also carries `costUsd` when the price is known. Stop reasons: `end_turn`, `max_tokens` (the answer hit the output limit), `max_turns`, `token_limit`, `cost_limit`, `time_limit`, `blocked` (a `userPrompt` hook), `content_filter`, `aborted`, `error`. Hook and compaction failures are recoverable `error` events (`HookError`, `CompactionError`).

`parentAgentId` lets a UI render sub-agent activity nested under the call that spawned it.

Event order for tools: every `tool.start` comes in the model's call order. All permission decisions (and approval requests) happen before any call runs, so a denial can be reported before an earlier call finishes; consumers match `tool.end` to `tool.start` by `callId`. Results go back to the model in call order. An `approval.request` is registered before it is emitted, so a consumer may call `session.approve` as soon as it sees the event.

### 4.3 Providers

```ts
interface ModelClient {
  readonly id: string;                         // 'azure:my-gpt5-deployment'
  readonly capabilities: ModelCapabilities;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

interface ModelCapabilities {
  contextWindow: number; maxOutputTokens: number;
  toolCalling: boolean; parallelToolCalls: boolean;
  vision: boolean; reasoning: boolean; promptCaching: boolean;
}

interface ModelRequest {
  system: string; messages: Message[]; tools: ToolSpec[];
  maxOutputTokens?: number; temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  providerOptions?: Record<string, unknown>;   // escape hatch, e.g. cache hints
}
```

- **First adapter: Vercel AI SDK provider packages** — the adapter calls the provider model's `doStream` (the `LanguageModelV4` interface from `@ai-sdk/provider`) directly. The high-level `ai` package is not used: its `streamText` brings its own step loop, tool execution and approvals, which the engine owns. This gives broad provider coverage on day one. Provider packages are imported on first use, so only the provider in use is loaded. OpenAI and Azure keep the items of a conversation (reasoning, tool calls, answers), and the history sent back refers to them by id; when one has expired or gone missing ("Item with id 'rs_…' not found"), the adapter makes the call again, and every later one of that client, with the history inline: earlier reasoning is left out, the rest is kept.
- **Model strings:** `provider:model`, e.g. `openai:gpt-5`, `anthropic:claude-sonnet-5-5`, `azure:<deployment>`, `ollama:<model>`, or a custom provider name defined in config.
- **Model catalog:** built-in table of known models (context window, capabilities, prices), overridable in config — needed because providers don't report these.
- **Credentials:** read from standard env vars by default (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`, …) or via `env('NAME')` references in config. Raw secrets never appear in config, prompts, logs or traces.
- **Scripted provider:** a fake model that replays scripted responses — used for deterministic tests of the loop, hooks, permissions and sub-agents without API calls.
- A native adapter can be written for any provider later without touching the core.

### 4.4 Tools

```ts
export const searchTickets = defineTool({
  name: 'search_tickets',
  description: 'Search the support ticket system. Returns up to 20 tickets.',
  kind: 'network',                              // read | write | execute | network
  parameters: z.object({
    query: z.string(),
    status: z.enum(['open', 'closed']).optional(),
  }),
  subject: (args) => args.query,                // what permission rules match against
  async run(args, ctx) {                        // ctx: workspace, signal, logger, emitProgress
    const tickets = await api.search(args);
    return formatTickets(tickets);              // string or content parts
  },
});
```

Built-in toolsets (each project enables what it needs):

| Toolset | Tools | Kind |
|---|---|---|
| `fs` | `read_file`, `write_file`, `edit_file` (exact string replace), `list_dir`, `glob`, `grep` | read / write |
| `shell` | `run_command` (timeout, cwd, stdout and stderr interleaved, exit code; `background: true` for servers and watchers), `command_output` and `stop_command` for background commands | execute; read |
| `web` | `web_fetch` (URL → Markdown) | network |
| `http` | `http_request` (only the APIs in `http.apis`, which add their own headers) | network |
| `todo` | `todo_write` — task list shown in the UI, helps on long tasks | read |
| `agents` | `delegate` — sub-agents (§4.7) | depends |
| `skills` | `load_skill` (§4.8) | read |

Git is used through `shell` in v1. Web search is not built in for v1: projects that need it add a search MCP server (Brave, Tavily and Exa each publish one) — one config entry, no harness code. All file tools resolve paths through the workspace and cannot leave its root unless configured.

File tool behaviour worth knowing:

- **Read before write.** `write_file` (on an existing file) and `edit_file` only work on a file the model has read in this session and that has not changed since. This stops the model from overwriting content it never saw, or that the user or a command changed in the meantime.
- **Line endings.** `edit_file` keeps a file's CRLF line endings and byte order mark; the model always writes `\n`.
- **Several edits per call.** `edit_file` takes one `old_string`/`new_string` pair or an `edits` list for one file, applied in order (each to the result of the one before) and written only if all apply; an error names the edit that failed. The tool guidance asks for independent changes in one response. Every response is a model call that re-sends the whole context: in one fix, 49 edits took 49 calls of about 59k tokens each, 78 of the run's 100 turns.
- **User interfaces.** The tool guidance (always, not only with a plan) says that tests do not see layout: after a UI change, look at it with a tool that can, or tell the user exactly what to check and where.
- **Search.** `glob` and `grep` use the bundled ripgrep (`@vscode/ripgrep`): fast, respects `.gitignore`, skips hidden files. `read_file` pages long files by line (`offset`/`limit`) and stays below the truncation limit (§4.9).

Web and API tools (M6):

- **`web_fetch`** converts HTML to Markdown (`node-html-markdown`, without scripts, styles, navigation and footers) and returns JSON and text unchanged. Long pages come in parts (`start_index`). Its permission subject is the hostname, so a rule or a session approval covers one site (`web_fetch(*.python.org)`). Redirects are followed only within that hostname; a redirect elsewhere is reported to the model, which has to fetch the new address itself, so a redirect cannot skip an approval.
- **`http_request`** exists only when `http.apis` lists base URLs. A request must fall under one of them; the API's configured headers (e.g. `env('TOKEN')`) are added last, so the model can neither see nor replace the credentials. The subject is method and origin (`GET https://api.example.com`), so one approval covers, say, every read of an API.
- **`todo_write`** replaces the whole list on each call (pending / in_progress / completed). The list lives in the session's history, so a resumed chat shows it again; the chat renders each version as a checklist.

### 4.5 MCP client

heaw is a **generic MCP client**: any MCP server works, and nothing in the code is specific to a particular one. GitHub and Jira are examples, not special cases.

**Configuring servers.** Three places, merged by server name (later wins):

1. `~/.heaw/mcp.json` — personal servers, available in every project.
2. `.mcp.json` at the project root — the format many MCP servers already document for other clients (`{ "mcpServers": { "<name>": { … } } }`), so installing a server is usually pasting the snippet from its README. Values can use `${VAR}` (and `${VAR:-default}`) to read the environment, so the file can be committed without secrets.
3. `mcpServers` in `heaw.config.ts` — the same shape, with `env('NAME')` for secrets.

```jsonc
{
  "mcpServers": {
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
    "github": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
                "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "tracker": { "type": "http", "url": "https://mcp.example.com/mcp", "oauth": true }
  }
}
```

Per server, optionally: `includeTools` / `excludeTools`, `trusted` (see permissions below), `timeoutSeconds`, `disabled`.

**Transports.** stdio (any command: `npx`, `uvx`, `docker`, a binary) and Streamable HTTP, falling back to the older SSE transport when a server does not speak Streamable HTTP.

**Startup.** Servers connect in parallel when the engine starts; a slow or broken server never blocks the chat. Tools appear as their server comes up; a server that fails is shown with its error (`/mcp`, `heaw mcp list`) and its tools are left out. The tool list and the system prompt are read again before each model turn, so reloading servers mid-conversation needs no restart.

**Tools.** Exposed as `mcp__<server>__<tool>`, with the server's description and input schema. Results are converted to text (images and resources are summarised for now). Calls time out (default 60 s, per server `timeoutSeconds`), and a crashed server becomes a tool error, never an engine failure.

**Permissions.** MCP tools are `execute` (ask by default) unless the server is `trusted`, in which case tools annotated `readOnlyHint` count as `read`. Rules match tool names: `mcp__github__get_*`, `mcp__jira__*`.

**Server instructions.** Many servers send usage instructions when they connect; they are added to the system prompt, labelled with the server name.

**Managing servers** (`--scope project` writes `.mcp.json`, `--scope personal` writes `~/.heaw/mcp.json`):

| Command | Does |
|---|---|
| `heaw mcp add <name> -- <command> [args…]` / `heaw mcp add <name> --url <url>` | add a server (`--env K=V`, `--header K:V`, `--oauth`) |
| `heaw mcp search <query>` | search the official MCP Registry |
| `heaw mcp install <registry name> [--as <name>] [--remote]` | add a server from the registry: fills in the command or URL, lists the environment variables it needs and the optional settings it left out |
| `heaw mcp list` / `heaw mcp test <name>` | connect and show status and tools |
| `heaw mcp remove <name>` | remove a server |
| `heaw mcp login <name>` / `heaw mcp logout <name>` | OAuth login or logout |

In the chat, `/mcp` shows the servers, `/mcp reload` reloads them and `/mcp login <server>` logs in.

**Installing from the registry.** A registry entry becomes a config entry: a local package is preferred (npm via `npx`, then PyPI via `uvx`, then a Docker image), a remote server otherwise or with `--remote`. Secrets never land in `.mcp.json`: they become `${VAR}` references. Variables the entry names itself (`GCS_PROJECT_ID`) keep their names; placeholders such as `{token}` become variables named after the local server (`GITHUB_TOKEN`). In the registry format an input is optional unless marked required, so optional inputs that need a value of their own are left out and listed, ready to paste (e.g. a token for a server that can also log in by itself). A remote server without credential headers gets `"oauth": true`.

**The agent can install servers itself.** The `mcp` toolset gives the model `mcp_search` (search the registry) and `mcp_reload` (reload after it changed `.mcp.json`). Adding a server means running someone else's code, so it takes two approvals by default: writing `.mcp.json` (the approval shows the command) and reloading (the approval lists the servers that will start).

**OAuth** for HTTP servers follows the MCP authorization spec — server metadata discovery, dynamic client registration when the server supports it (otherwise a configured `clientId`), authorization code + PKCE with a browser login and a localhost callback, automatic token refresh. The MCP SDK runs the protocol; heaw supplies an `OAuthClientProvider` that stores the results. Many hosted servers (e.g. Atlassian's official one) only offer OAuth.
  - `heaw mcp login <server>` / `heaw mcp logout <server>`, or `/mcp login <server>` in the chat, which reconnects the server afterwards. A server that refuses a connection without a login shows as `needs-login` with these commands.
  - Connecting only ever uses a saved login: it never registers a client or opens a browser, so starting the chat stays quiet. Only a login does both.
  - The callback listens on `127.0.0.1`; the login reuses its last port so the registered client stays valid (`oauth.callbackPort` fixes it for clients registered in advance). The callback checks `state` and ignores anything else.
  - Logins are stored per server URL in `~/.heaw/credentials/mcp/` with user-only file permissions — never in the project or in session logs — so projects using the same server share one login. (OS keychain storage is on the roadmap.)
  - Non-interactive runs (`heaw run`) reuse stored tokens but cannot open a browser, so log in once interactively first.

**Later:** MCP prompts (as slash commands) and resources; sampling and elicitation.

**Tools on demand** (`mcpTools`, default `auto`: on demand above 20 tools). Every tool's schema goes with every model call, and a server such as GitHub's brings dozens: thousands of tokens on each turn for tools the task never needs. On demand, the system prompt lists the project servers' tools by name with the first sentence of each, and `load_tools({ names })` adds them to the conversation from the next step on. The list always shows all of them, loaded or not, so loading does not change the prompt's cached start. A resumed conversation gets back what it had loaded (from its `load_tools` calls), a sub-agent has what its caller loaded, an agent file that names its tools gets exactly those, and an agent's own servers (§4.7) are never deferred. Calling a tool before loading it gets an error that says so.

### 4.6 Instructions

The system prompt is assembled in layers (later = more specific):

1. **Harness base prompt** — how to use tools, verify work, be concise. Short; replaceable.
2. **Global** `~/.heaw/AGENTS.md` — personal preferences.
3. **Project** `AGENTS.md` at the project root — the open AGENTS.md convention, so the same file serves other agents too. HTML comments are removed before sending (template hints are not instructions), a file left with only headings is skipped (an untouched `heaw init` template costs nothing), and files over 20,000 characters are cut. Later files win over earlier ones; the user's messages win over all files.
4. **Agent definition** body — for named agents and sub-agents.
5. **Environment block** — date (with weekday and time zone), OS, shell, workspace type, cwd, git branch/status summary. No time of day: it would change the prompt on every call and defeat prompt caching. Date, OS and cwd exist since M1; the rest arrives with M2 and M4.
6. **Skills index** — names and descriptions only.

Ordering keeps stable content first so providers with prompt caching can reuse the prefix.

**Subfolders.** Generators put their own instructions into the folder they create (`create-next-app` writes an AGENTS.md telling agents that Next.js 16 is not the one they were trained on; Prisma installs skills into `.agents/skills/`). The first time a tool touches a path under a folder (`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command` with `cwd`), a built-in `afterToolCall` hook adds that folder's AGENTS.md and the skills of its skill folders (§4.8) to the result, for it and each folder between it and the root, once per session and agent. `node_modules`, `.git` and `.heaw` are skipped. Skills found this way are added to what `load_skill` can load (the tool appears with the first one, when the project had none), and the project's own skills win by name.

### 4.7 Agent definitions and sub-agents

Named agents live in `.heaw/agents/*.md`:

```markdown
---
name: reviewer
description: Reviews a diff for bugs and risky changes. Read-only.
model: anthropic:claude-sonnet-5-5     # optional, defaults to the session model
tools: [read_file, glob, grep, run_command]
maxTurns: 30
---
You are a code reviewer. Report concrete bugs with file:line references...
```

**An agent's own MCP servers** (`mcpServers:` in its file, in the shape of `.mcp.json`) start when it first runs and stay up for its next run until the engine closes. Their tools are added to the ones `tools` picks from the caller, and allowed for that agent in any mode unless a deny rule matches: the user put them in its file (a protected file). No other agent sees them. This is for capabilities only one role needs: Playwright's browser server has about 25 tools, and sending their schemas with every call of the main agent would cost tokens on every turn for nothing. A run waits up to two minutes for them (the first start may download the server), and a server that did not start is named in the agent's prompt with its error, so it reports that instead of guessing.

**Tester** (`/setup` writes `.heaw/agents/tester.md` for a web app): reviewers read code, and in the CRM the problems only the user caught were the ones a user sees. The tester has the read tools, `run_command` (to start the dev server in the background, left running for the next test) and the browser server headless with an in-memory profile, without the tools that run arbitrary code or upload files. It reads the diff, uses the changed pages like a user (forms with realistic and one wrong input), checks the console and failed requests, and ends with `Verdict: works`, `fix first` or `could not test`. The `beforeStop` hook `/setup` writes runs it after the tests pass when interface files changed and sends the agent back only on "fix first"; during a plan build the agent delegates to it for interface steps. It works through Playwright's accessibility snapshot (flows, text, values) and looks at a screenshot of each changed page, wide and 390 pixels narrow, for layout. Playwright's files go to `.heaw/tester/` (`--output-dir`; by default they land in the project). Trials with gpt-5.4 on a small contact list:

- A new add form that sent the email under the wrong name and did not update the count: it found both, with the steps to see them, and said "fix first" (11 turns, $0.06, 41 seconds).
- The form working, but a stylesheet that cut the entries off and put the button over the Name field, which a snapshot cannot show: with the screenshot only described, it called the layout "orderly"; with the image, it found both at both widths (13 turns, $0.10, 45 seconds). Two lessons are in its instructions: a screenshot saved under a `filename` comes back as a link without the picture, and a page it has not seen is never called fine.
- On the CRM copy (a React and Express app with a login), asked to make the Deals page usable on a phone: the first tester spent its 40 turns on the sign-in form, filters and creating a deal, read page snapshots Playwright had saved to files, never looked at the phone width, and ended without a verdict, which the check took as a pass. Its instructions now put the change first, at both widths, use the demo login from `AGENTS.md`, leave the rest of the app alone and keep to about 25 steps; the next run checked both widths, tapped the cards and said "works" (34 turns, $0.41), correctly.

The `delegate` tool:

```ts
delegate({
  agent?: string,          // a named agent, or omit for an ad-hoc agent
  instructions?: string,   // ad-hoc: system prompt written by the calling agent
  tools?: string[],        // ad-hoc: subset of the caller's tools
  task: string,            // what to do; the sub-agent sees only this, not the parent history
  files?: string[],        // globs of the only files it may change; other writes are denied
  check?: string,          // a command that shows it is done; it must pass before it reports
})  // → the sub-agent's final message
```

`files` and `check` are added to the task it gets. With `files`, its permission view denies writes outside them, so parallel sub-agents cannot step on each other or on the shared files the caller connects them in (commands it runs are not limited by this). With `check`, a sub-agent that can run commands and reports while the last run of that command (alone or in a chained line) did not pass is sent back once with a note to make it pass; if it still did not, the report says so. One that cannot run commands is told the caller runs it.

Limits the engine enforces:

- **No privilege escalation:** a sub-agent's tools ⊆ the session's enabled tools; its permission policy is the parent's, optionally tightened, never loosened.
- **Depth limit:** default 1 — sub-agents don't get `delegate`. Configurable.
- **Budgets:** per sub-agent max turns, tokens and wall time; the parent's total budget includes children.
- **Parallelism:** several `delegate` calls in one model turn run concurrently (configurable cap).
- **Approvals** from sub-agents surface in the UI labelled with the sub-agent's name.
- **Isolation:** fresh context; only the final summary returns to the parent.

How it works (M7):

- **Definitions** come from `~/.heaw/agents/*.md` (personal) and `.heaw/agents/*.md` (project, wins by name), parsed with a YAML front matter reader. Fields: `name` (default: the file name), `description` (required), `tools`, `model` (`provider:model`, or `inherit` for the caller's; without one, `subagents.model` if set, else the caller's; a short name like `sonnet` is ignored with a warning), `mode` (a stricter permission mode), `reasoningEffort` (e.g. `high` for a reviewer), `maxTurns` / `maxTokens` / `maxCostUsd` / `maxMinutes`. `subagents.model` lets sub-agents run on a cheaper model than the main agent; it is created when the engine starts, so a wrong name or a missing price for a cost limit shows then (and in `check_config`), not in the middle of a task. Claude Code tool names (`Read`, `Grep`, `Bash`, `Task`, …) map to heaw's, so existing agent files work. Unusable files are reported (chat and `heaw run` print the warnings) and skipped; they never stop heaw.
- **The sub-agent's prompt:** the definition body (or the caller's `instructions`, or a generic role) + what a sub-agent is (it reports to another agent, cannot ask the user, ends with a self-contained report) + tool guidance + the project's AGENTS.md + environment, and the MCP and skills sections when it has those tools. Its first message is `task`. Its tool guidance has no planning (it cannot get a go from anyone); without `run_command`, it leaves builds and tests to its caller instead of being told to run them (a read-only reviewer otherwise ended every report with "I could not run the tests").
- **Reviews:** the `reviewer.md` that `heaw init` writes splits findings into must-fix and at most three optional points and ends with a verdict ("OK to continue" or "fix first"), judged by what the change is for and the size of the project. The `delegate` description and the plan-work skill tell the caller to act on what matters and review again at most once after a large fix: a reviewer always finds one more test to add, and a build that made "the reviewer finds no issues" a step's check went through five rounds for one step and added race handling to a simple app.
- **Parallel work:** the plan-work skill marks steps with their own files as a group, builds what they share first, and then delegates the group in one turn; the main agent connects the parts in the shared files and runs all checks.
- **Tools:** the caller's current tools (MCP included), filtered by the definition's or the call's `tools`; `delegate` only while the depth allows. `delegate` itself is a `read` tool (every call the sub-agent makes is checked on its own), so it needs no approval; rules can name agents: `delegate(reviewer)`.
- **Permissions:** the parent's policy object, so rule and mode changes and "allow for this session" apply to both. A definition's `mode` (and `delegate`'s `files`) adds a restricted view that only ever answers stricter (deny over ask over allow). What the mode denies is denied (writes and commands in `read-only`); what it asks about is asked about only where the parent allows by its own mode (`bypass`), never past an allow rule, a session grant or an approval. Before, a tester with `mode: accept-edits` was asked about every command although the config allowed it and the user had answered **a** each time.
- **Approvals at the same time:** parallel sub-agents can ask at once. Every request waits in the session that owns the conversation, the chat queues them (the prompt says how many more are waiting), and an answer "for the session" re-checks the waiting ones and lets through those it now covers, each with its own `approval.response`. Before, the chat kept only the latest request: the first was never answered and its sub-agent, and the run, waited forever.
- **Approvals** go through the session that owns the conversation: the sub-agent's `approval.request` events carry its `agentId`, and the UI answers them with the parent session's `approve`.
- **Events:** a sub-agent's events flow into the parent's stream as they happen, with `parentAgentId` set, and are saved in the parent's session log. `subagent.start` / `subagent.end` (name, stop reason, turns, usage, cost) bracket them. UIs show its tool calls under its name and hide its streaming text; the report arrives as the `delegate` result.
- **Budgets:** each model call's `usage` event counts toward every ancestor's run, so the parent's token and cost limits include its sub-agents. A sub-agent's own limits are capped at its share of what the parent run has left: split evenly among the `delegate` calls of one batch (`ToolContext.together`), so a parallel group does not each get all of it and all stop at once. A share below `subagents.minBudget` (default $0.50 and 30,000 tokens) starts nothing; the call returns why and advises finishing in a few steps or stopping with a summary. Its time is bounded by the parent's abort signal. Defaults per sub-agent: 50 turns (`subagents.limits`). A report from a sub-agent that stopped early says why.
- **Near a limit:** once a run has used 80% of its turn, token, cost or time limit, the agent is told so once (a note on its last tool result, which every provider accepts after tool calls, and a `limit.near` event): finish in as few steps as it can, start nothing big, and report what is done and what is left. Sub-agents get the same about their own share. Before, four sub-agents started with less than $1 left all hit the cost limit within a minute.
- **Prompt:** what all sub-agents share comes first (sub-agent guidance, tool guidance, project instructions, environment) and the agent's role last, and requests carry a cache key per session and agent kind, so parallel sub-agents of a kind can reuse each other's cached prompt start (§4.9).
- **Parallelism:** delegate calls in one turn run together, up to `subagents.maxParallel` (default 4); the rest wait.
- **Hooks:** `subagentStart` can rewrite or block the task, `subagentEnd` can change the report. Inside sub-agents, tool, model-call and compaction hooks run (so guards hold); `sessionStart`, `userPrompt`, `beforeStop` and `sessionEnd` do not, as they concern the user's conversation.

Workflows (fixed sequences such as plan → implement → review) are written in code using the library API (§7): `engine.runAgent(name, task)` runs `main` or a named agent without a UI, and `engine.callTool(name, args)` calls a tool directly. Both run non-interactively: what needs approval is denied unless `allow` rules permit it.

### 4.8 Skills

`.heaw/skills/<name>/SKILL.md` with frontmatter `name` and `description`, plus optional supporting files. Only the index enters the system prompt; `load_skill(name)` returns the full body and lists supporting files the agent can read with `read_file`. Format follows the common `SKILL.md` convention so existing skills can be reused.

**Plan mode** (built-in skill `plan-work`): the agent enters it itself with `start_plan` when it judges a task needs proper planning (the base prompt asks it to for anything bigger than a few files), or the user types `/plan <task>`. The session (`Session.enterPlanMode`) switches to `read-only` with `PLAN.md` approved for writing and reasoning effort `high`; entering needs no approval, since it only restricts. When `PLAN.md` is ready the agent calls `finish_plan`, a tool that always asks the user (`Tool.alwaysAsk`, in every mode, read-only included): yes ends plan mode and the agent builds in the same turn; no with feedback sends it back to revise the plan; in a run nobody can answer, plan mode stays on. Sub-agents get neither tool. The agent reads the code, asks three to five questions whose answers change the design (each with a suggested answer), and writes `PLAN.md`: goal and non-goals, design with the alternatives rejected, risks and the step that proves each early, tests (a benchmark when speed or volume is a requirement), and small steps with a check each, the first a skeleton that builds with one passing test. Approval (or `/plan go`) restores the previous mode and effort, and the agent builds the whole plan in one go, ticking steps off, and stops early only when the plan proves wrong or it needs the user; `/plan off` leaves without building. Models tend to stop after each step anyway, to report and ask whether to go on; so while an approved plan has open steps, a run that started the build or ticked a step and then stops is sent back once per step ("PLAN.md still has 3 open steps; the next is: …"), and an agent that stops again without progress is left alone, as it is waiting for the user on purpose. Progress is ticked steps plus completed items of the todo list, since models track steps in either; the reminder asks for the steps to be ticked in `PLAN.md`. A run about something else is not sent back. A new plan (`start_plan`, `/plan <task>`) first moves an existing `PLAN.md` to `.heaw/plans/<date>-<title>.md`, so earlier plans are kept. The base prompt also asks for a plan before anything bigger than a few files, for building in small verified steps, and for stopping (not faking) when the environment lacks a tool. In a run without a user (`heaw run`, an eval trial, `runAgent`), `start_plan` refuses unless a rule given in advance approves `finish_plan`: the plan could only end at a denied approval with nothing built, as an eval trial did, so the agent builds directly.

**Plans across conversations.** A conversation that starts while `PLAN.md` has open steps (after `/clear`, or the next day) tells the agent with its first message how many steps are open and which is next: read the plan first if the message continues that work, otherwise leave it alone. A run that then ticks a step is sent on to the next one before it may finish, as in the conversation that approved the plan; one about something else ticks none and is left alone (the `continue-plan` eval: without this, gpt-5.4 did one step and stopped in two of three trials). The note goes with the message rather than into the system prompt, which would go stale as steps are ticked and change the cached prompt start. While an approved plan is built, a change to `PLAN.md` that removes or rewrites approved steps gets a note on its result: keep them, tick them, add notes or new steps after them, and tell the user when a step proved wrong. Models drop a step they find hard and then report the plan done (Anthropic keeps feature lists in JSON for this reason); here a check on the steps does it. A step counts as kept while its text is there, with a tick, strike-through or a note added; what the user changes in `PLAN.md` between runs is adopted.

**Built-in skill `retro`** (`/retro [session] [notes]`): the ratchet of harness engineering, where every repeated mistake becomes a rule, a check or a tool. Its `session_report` tool condenses a saved session (a 3.5 MB log into about 6,000 characters): the runs with what each cost, denials with the user's feedback, failed calls grouped by command with how often the output was the same, approvals asked again and again, checks that sent the agent back, where heaw stepped in (going in circles, near a limit, compaction), calls the same agent repeated, file changes made one per model call, sub-agents, what filled the context and the files changed most; with `run`, one run step by step. Without a session it takes the current conversation when that had earlier runs (leaving out the review itself), otherwise the latest saved one. The skill looks for the patterns that cost turns, money or quality, the cause of each, and the smallest lasting fix in the right place, preferring checks to instructions: an `AGENTS.md` line for a fact the agent could not know, a hook for a mistake a command can catch, an allow rule for a safe command asked about again and again, a skill for a procedure, an agent file for a sub-agent, and an eval case from the session (`heaw eval add --from-session`) to keep it fixed. At most five proposals, each with the numbers that show the problem; the user picks. One-off slips are skipped, and heaw's own bugs are reported rather than worked around. A first review of the CRM proposed two of three changes the session did not support, so the skill now asks for evidence: a failure, a correction or waste with a clear cause, not "could have worked differently" after a good result. It proposes sub-agents only for a context that ran out, keeps heaw's own guidance out of `AGENTS.md` (it is sent on every call already), explains how allow-rule patterns match (`git status*`, while commands that write stay narrow), and suggests an eval case only when the session started from a commit that holds the project. `session_report` is added by `loadProject` (it reads `.heaw/sessions/`), next to `check_config`.

**Built-in skill `setup-harness`** (`/setup`): every project gets it (a project skill of the same name replaces it). It carries the config reference, since heaw is not in any model's training data, and a step-by-step flow, one topic and at most two questions per message, each with a suggested answer: the project (for an empty folder the agent proposes the stack and commands itself), the toolchain (checked with version commands before any check relies on it; never faked), one fast check before finishing, autonomy and budget, services (none means nothing is written), then write `AGENTS.md`, `heaw.config.ts`, `.mcp.json` and `.env.example` (config changes are asked about, as protected files), call `check_config` until the setup loads, and hand over. `check_config` loads the project exactly as heaw would (config, rules, the model and its credentials, a cost limit without a price, MCP servers, agents, skills) and returns the first problem or a summary. `/reload` builds a new engine from the current files (and variables added to `.env`), continues the conversation in it (`Engine.continueSession`, keeping plan mode or a plan build), and closes the old one with its background commands; a setup that does not load leaves the old one in use. The chat does the same by itself: before each message and after each run it compares the setup files (`heaw.config.*`, `.mcp.json`, `AGENTS.md`, agents, skills) with what it loaded and applies changes, whether the agent or the user made them, so a setup written by `/setup` is not left unapplied because nobody typed `/reload`.

How it works (M7): skills come from `~/.heaw/skills/` and, in the project, from `.claude/skills/`, `.agents/skills/` (the folder several agents and tools such as Prisma use) and `.heaw/skills/`, later ones winning by name, so skills written for other agents work unchanged; skills in subfolders are found as the agent works there (§4.6); a skill without a description is reported and skipped. `load_skill({ name, file? })` returns the body and the supporting files (up to 50, hidden ones left out), shown with the folder's path relative to the project when inside it, so scripts can be run from there; with `file` it returns that file, which must be inside the skill's folder. Reading through `load_skill` rather than `read_file` also works for personal skills outside the workspace. The index tells the model that skills take precedence over its habits and that loading one is the first step — softer wording let gpt-5.4 skip skills for simple tasks.

### 4.9 Context manager

- **Token accounting:** requests are estimated at about four characters per token, and the estimate is calibrated after every call against the provider's reported input tokens, so it fits each provider and kind of content. The usable window is the context window minus the model's maximum output (e.g. 272k of gpt-5's 400k).
- **Tool output truncation at the source:** outputs over a limit (default ~30k chars) are cut, keeping the start and the end (command output often ends with the errors); the full output is saved to `.heaw/sessions/<id>/outputs/` and its path is told to the model. That folder carries its own `.gitignore` (`*`), so saved outputs stay out of git even before `heaw init`. A tool can ask for a smaller limit and more of the end (`Tool.output`): `run_command` keeps 12,000 characters, a quarter from the start and three quarters from the end, since a build or test run prints far more than the agent needs and ends with what matters.
- **Images in tool results** (`ToolOutput.images`, from MCP image content such as a screenshot): the text keeps a description (`[image, image/png, 52000 bytes]`), and the image goes along only to a model that can see (`capabilities.vision`) through an API that takes images in tool results, the OpenAI Responses API (also Azure's) and Anthropic's. Chat Completions APIs, such as Ollama's, would get the image as JSON text, megabytes of base64. Only the three latest results keep their images (about 1,100 tokens each with OpenAI, paid on every later call, and an old screenshot shows a page as it was), the estimate counts 1,500 tokens per image, and saved sessions and events keep only the description.
- **Repeated reads:** `read_file` of the same lines of a file whose content is unchanged (by hash) returns a short note that the earlier result still has it, once; asked again, the content comes. In one build, 22 of 233 reads repeated an earlier one, and every repeat stays in the context and is paid for on every later turn. What the model has been shown is tool state under `context.` keys, cleared when the history is compacted (those results may be gone then).
- **Compaction** before a model call whose request would exceed a threshold (default 80% of the usable window, `context.compactAt`, `false` turns it off):
  1. Clear old tool results: long outputs outside the four most recent tool turns become a short placeholder. Cheap, and enough when it frees a quarter of the threshold.
  2. Otherwise summarize older turns with one model call. The most recent turns stay as they are: at most a quarter of the window and 30% of the history. The cut never separates a tool call from its result. The summary goes into a user message followed by a short assistant acknowledgement, so roles keep alternating for every provider. The transcript sent for summarizing keeps what the user and the agent said and cuts tool outputs harder until it fits; if it still does not, the middle goes, never the start with the user's request. Less than 1,000 tokens of older history is not worth summarizing.
- If compaction cannot get below the threshold, it is not retried until the history grows. A failure is a recoverable error, and the turn goes ahead.
- `beforeCompact` hooks see the whole history and return text to keep word for word. A built-in one keeps the latest `todo_write` list. `/compact [focus]` summarizes on request, optionally focused.
- **Prompt caching:** stable prefix ordering (system → tools → history), plus provider cache hints where supported. `ModelRequest.cacheKey` (the session id and the agent kind) is sent as OpenAI's and Azure's `promptCacheKey`, which routes requests that share a prompt start to the same cache.
- **Memory** (`memory` toolset, on by default): `remember` appends a dated note to `.heaw/memory.md`; every later session gets the notes in its system prompt (the newest 12k characters), with a reminder that notes can be out of date. Saving is a change to `.heaw/`, so it is always asked about (§4.10): nothing enters the memory, and so every later prompt, without the user's approval, which also keeps a prompt injection from planting itself there.

### 4.10 Permission engine

Every tool call is evaluated: **deny rules → approvals → protected paths → ask rules → allow rules → mode default**. Approvals are the user's "allow for this session" answers and rules allowed in advance for a session or run (`--allow`, the `allow` option of `runAgent` and `callTool`, an eval case's `allow`): an explicit go-ahead for this run, so it covers calls that an ask rule in the config would ask about. A config allow rule does not: `ask` exists to carve exceptions out of broad allow rules (`mcp__github__*` allowed, `create_pull_request` asked).

Rule forms:

- `tool` — every call of that tool.
- `tool(pattern)` — a glob matched against the tool's `subject`: the command for `run_command`, the path for file tools, the host for network tools.
- `*` in tool names — e.g. `mcp__github__get_*` or `mcp__jira__*`.
- MCP tools have no `subject` in v1 (their arguments are arbitrary), so rules for them match the tool name only.
- A command line is split into its commands at `&&`, `||`, `;`, `|`, `&` and line breaks, outside quotes. Deny and ask rules apply when they match any command; allow rules, rules allowed in advance and session grants allow the line only when each command is allowed (output piped into `head`, `tail`, `grep`, `wc`, `cut` or `tr` needs nothing). Matching the whole line let `run_command(npm *)` allow `npm test && rm -rf …`, and slipped `npm test; rm -rf x` past `run_command(rm -rf*)`. A line with substitution (`$(…)`, backticks, `<(…)`) or an open quote cannot be split safely, so only a rule without a pattern allows it. "Yes for the session" on a line grants the leading words of each of its commands, unless one of them is a program that can run anything, so a build's checks (`npm run test -- deals && npm run build && npm test`) are not asked about again at every step.

```ts
permissions: {
  mode: 'default',
  allow: ['run_command(npm test*)', 'edit_file(src/**)', 'mcp__github__get_*', 'mcp__jira__jira_search'],
  ask:   ['run_command(git push*)', 'mcp__github__create_pull_request'],
  deny:  ['read_file(**/.env)', 'read_file(**/.env.!(example))', 'run_command(rm -rf*)', 'mcp__github__merge_pull_request', 'mcp__github__delete_*'],
}
```

| Mode | read | write | execute | network |
|---|---|---|---|---|
| `default` | allow | ask | ask | ask |
| `accept-edits` | allow | allow (inside workspace) | ask | ask |
| `read-only` | allow | deny | deny | ask |
| `bypass` | allow | allow | allow | allow — deny rules still apply; warns unless the workspace is `docker` |

**Protected paths.** Writes to `heaw.config.*` (code heaw runs at start), `.mcp.json` (commands it starts), `.heaw/**` (agents, skills, memory, session logs) and `.git/**` (hooks and config git runs) are always `ask`, in every mode including `bypass` and whatever the allow rules say (`read-only` still denies). An approval, asked or given in advance with `--allow`, lets one through. Without this, an agent allowed to edit files could loosen its own rules, remove the hooks that check it, or plant code that runs outside its sandbox the next time heaw or git starts. The Docker workspace adds read-only mounts for the same files (§4.12), so commands cannot change them either.

Approval answers: allow once · allow for this session · deny · deny with feedback to the model. "For this session" allows the call itself and, so the user is not asked again for every new file or every test filter: for a file edit in `default` mode, all file edits (the mode becomes `accept-edits`; protected files are still asked about); for a command, commands with the same leading words, the program and up to two subcommands or simple flags (`./mvnw -q test`, `npm run build`), never with chaining, redirection or substitution, and never for programs that can run anything or destroy things (shells, interpreters, `docker`, `curl`, `rm`, `kill`, …), which are allowed exactly. The prompt says which. Ask rules still ask. In non-interactive runs (`heaw run`), `ask` resolves to **deny** unless an `--allow` rule covers the call (or the mode is `bypass` and no ask rule matches).

**Command patterns are best-effort.** A shell command can be phrased in ways a pattern does not catch (`git push origin HEAD:main` instead of `git push origin main`). Permission rules are one layer of defense, not the only one. The docs and `heaw init` templates recommend external guards as well: branch protection on important branches, least-privilege tokens (scoped to one repo or project), and the Docker workspace for unattended runs.

### 4.11 Hooks

Hooks are TypeScript functions in the project config:

| Hook | Can |
|---|---|
| `sessionStart` | add context (e.g. current ticket, git status) |
| `userPrompt` | add context, rewrite or reject the prompt |
| `beforeModelCall` / `afterModelCall` | inspect or adjust the request, log the response |
| `beforeToolCall` | block, rewrite arguments, auto-approve |
| `afterToolCall` | append feedback to the result (e.g. lint errors after an edit) |
| `beforeStop` | reject the stop and feed back (e.g. tests still failing → keep working) |
| `subagentStart` / `subagentEnd` | rewrite or block a sub-agent's task; change its report |
| `beforeCompact` | choose what must survive compaction |
| `sessionEnd` | clean up, export reports |

`afterToolCall` and `beforeStop` are the main **verification** points: they let a project plug in its own checks so the agent sees its mistakes and fixes them.

How hooks behave (M5):

- Every hook gets the session and agent ids, the model id, the workspace (to run checks with `workspace.exec`) and an abort signal; returning nothing changes nothing.
- Several hook sets run in order: personal (`~/.heaw/config.ts`) before project. Rewrites (prompt, request, tool arguments) pass from one hook to the next; context and feedback are joined.
- `sessionStart` runs before a session's first run (also after a resume, with `resumed: true`); its context is added to the system prompt. `sessionEnd` runs when the session is closed: when the chat exits or `/clear` starts a new one, and after `heaw run`.
- `userPrompt` context is added as a second text part of the user message. A `block` ends the run with `blocked` before the model is called; the input does not enter the history.
- `beforeToolCall` runs after argument validation and before the permission check. Rewritten arguments are validated again, and permissions see them. `allow` answers an `ask` for the user, but a deny rule still denies. `block` returns the reason to the model as a denied call.
- `afterToolCall` runs for calls that ran; its feedback is appended to the output the model sees.
- `beforeStop` runs when the model finishes normally, with `editedFiles`: the files the file tools changed in this run (sub-agents' included, commands' not), so a check can skip a run that only answered a question. Feedback goes back as a user message ("A check before finishing reported: …") and the run continues; turn and cost limits still apply, so a check that never passes cannot loop forever. `heaw init` writes such a hook, running the project's tests, when it finds them (`npm test`, `cargo test`, `go test`).
- **A check that passes with a `note`** (e.g. what the tester found) sends it to the agent once: "The checks before finishing passed and reported: … Give your final answer again, with what they found." The agent had already written its answer when the check ran, and in the CRM trial that answer asked the user to check the page by hand although the tester just had. The checks do not run again unless a file was written since (`FileChanges.writes`). The `/setup` check skips the tester when only test files changed.
- **A final message that announces more work** ("Let me also run a quick check:", "Now I'll fix the test.") with no tool call would end the run there; it is sent back once per run: do it now, or give the final answer. The last sentence must start with "let me", "I'll" or "I'm going to" and a working verb (run, check, fix, …), and nothing that hands over to the user (a question, "let me know", "once you…") counts. A local model ended four eval trials this way.
- **Stuck checks end the run.** When `beforeStop` feedback is the same three times in a row (compared without timestamps and durations, so "4 tests failed" after "5 tests failed" counts as progress), the run stops with `check_failed` instead of looping to the turn limit: either the agent cannot fix it, or the check cannot run here (a missing tool). Found in practice: a Maven check without Maven installed sent the agent back 14 times.
- **The reminder to verify**, a safety net for projects without a `beforeStop` hook: when a run changed files (with the file tools, not counting `.heaw/`, `heaw.config.*` and `.mcp.json` (which `check_config` verifies), and `.md`/`.txt` files) and ran no command after its last change, the agent is sent back once with "You changed … and ran no command after that, so nothing has checked those changes …". It uses the project's own checks, which the agent finds as it does for any task, so it needs no configuration; `verifyChanges: false` turns it off. It is off when a `beforeStop` hook exists (that hook decides), and when no command could follow it: no command tool, or a one-shot run where the mode and rules allow no command (otherwise the agent only spends turns looking for checks it may not run).
- The context has `runAgent(name, task)` in the user's agent and in `runAgent` sessions: it runs a named agent (or `main`) to the end without anyone to ask and returns its answer, e.g. a reviewer's verdict in `beforeStop`. The agent it starts runs only tool hooks and gets no `runAgent` itself, so hooks cannot recurse. Each such run is recorded as `subagent.start` and `subagent.end` (with `summary`, the last line of its answer, usually a verdict), passed on once the hook returns: the chat shows `ui-tester: Verdict: works`, and the session log has it. In the CRM trial the tester checked the page while the agent, which never saw the result, told the user to check it by hand.
- A hook that throws is reported as a recoverable error and skipped, except `beforeToolCall`, which fails closed: a guard that crashed cannot vouch for a call, so the call is blocked.

### 4.12 Workspaces

```ts
interface Workspace {
  readonly kind: 'local' | 'docker' | string;
  readonly root: string;
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;      // stream output via callback
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  list(path: string, opts?: ListOptions): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat | null>;
  dispose(): Promise<void>;
}
```

- **`local`** — runs on the host. Shell: `HEAW_SHELL` if set; on Windows Git Bash (found next to `git.exe`, never the WSL `bash.exe` launcher), else Windows PowerShell; elsewhere the user's bash or zsh, else `/bin/sh`. PowerShell commands travel Base64-encoded so quoting cannot break them. Commands get no stdin, `NO_COLOR`, no pager and no git prompts; timeouts, Esc, `stop_command` and exiting heaw stop the whole process tree (`taskkill /T` on Windows, a process group elsewhere), and heaw waits for that before it exits. In Git Bash, `exec` in a script (the Maven wrapper, `mvn`) starts a new Windows process and ends the old one, cutting the parent chain `taskkill /T` follows, so each command also carries a `HEAW_EXEC_ID` and stopping it also stops every process Git Bash's `/proc` lists with that marker, with its subtree. Closing the terminal ends the chat the same way. Output that progress bars redraw with carriage returns keeps only the last version of each line. Paths are normalized; access outside `root` is denied unless configured. Git uses the host's normal credentials (e.g. Git Credential Manager on Windows).
- **`docker`** — a long-lived container per session (`docker run -d`, then `docker exec`), project mounted at `/workspace`, configurable image, network (`none` / `bridge`), CPU/memory limits. File operations go through the mount. Requires Docker or Podman (WSL2 on Windows).
  - **Credentials:** the container sees no host secrets by default. `env` passes chosen variables in (`env: { GH_TOKEN: env('GITHUB_TOKEN') }`), and `git: { tokenEnv: 'GH_TOKEN' }` sets up a git credential helper inside the container so HTTPS `git push` works. Git author name and email are copied from the host's git config. Pushing and package installs need `network: 'bridge'`. (SSH agent forwarding is on the roadmap.)
- **Docker, as built (M8):**
  - One container per heaw process (not per session: `/clear` keeps it), started in the background when the engine starts and on first use otherwise; a failed start is retried by the next command, e.g. after Docker Desktop was started, and reported as the command's output.
  - Files go through the mount on the host, so file tools and ripgrep work as in the local workspace; only commands run inside, via `docker exec -w /workspace/<dir>`. Paths starting with `/workspace/`, as the model may write after running commands, map to the project.
  - Defaults: image `node:24`, network `none`. Containers run with `--init` (reaps zombies), an entrypoint of `tail -f /dev/null` (works with images that have their own entrypoint), and on Linux hosts under the host's user id, so files they create belong to the user.
  - Stopping a `docker exec` client does not stop the command inside, so each command carries a marker variable (`HEAW_EXEC_ID`); a timeout or Esc kills every process in the container that has it, then the client.
  - The model is told where commands run: the environment block describes the container, the mount and whether there is network.
  - Secrets in `env` reach the container through the CLI's environment, never its arguments (so `ps` does not show them). The git credential helper names the variable; the token itself is never written to a git config.
  - Containers carry labels (`heaw.project`, a hash of the project path, and `heaw.pid`); starting removes containers of this project whose heaw process is gone. The CLI removes its container on exit.
  - Docker's errors become advice: not installed, installed but not running, image not found.
  - `bypass` mode warns only outside the Docker workspace.
- **Dev container** — the repo ships a `Dockerfile` and `.devcontainer/` so the whole CLI can run inside a container. The Dockerfile's default target is a slim runtime image (git, ripgrep from the npm package, runs as `node`, entrypoint `heaw`, project at `/workspace`); its `dev` stage backs the dev container, which adds Docker-in-Docker so the Docker workspace tests run there too. CI builds the image and runs it.
- Cloud sandboxes can be added later as new `Workspace` implementations.

Read-only mounts over the project, for those that exist: the config files, `.mcp.json`, `.heaw/` and `.git/hooks` (§4.10). `.git/config` stays writable because `git push -u` writes to it; files the host runs later that are ordinary project files (`package.json` scripts, editor tasks) are the project's to review, as with any change.

### 4.13 Sessions

- A session is an append-only **JSONL log** in `.heaw/sessions/<id>.jsonl`. The folder carries its own `.gitignore` (`*`), so sessions never end up in git, with or without `heaw init`.
- Records: one `session` header (id, created, cwd, model), then `message` records (every message added to the history) and `event` records (everything else, for display and audits). Streaming deltas and `message.complete` are not saved; the `message` records already hold the complete text.
- The header is written with the first message, so a chat that was opened and closed without a message leaves no file. Records are written through one queue in order; a failed write is reported once as a recoverable `error` event and does not stop the run.
- Ids are readable and sort by time (`20261030-141523-k3f9`); `heaw resume` accepts any unique prefix.
- `heaw resume [id]` rebuilds the history from the `message` records; a `compaction` record holds the history after a compaction and replaces everything before it (the log stays append-only). Usage and cost are totalled from the per-call `usage` events, which also cover a `/compact` outside any run. Tool calls left without results by a crash are answered with "not run". Not restored, on purpose: "allow for this session" approvals and the read-before-write state, so after a resume files must be read again before they are changed.
- `heaw run` saves its session too and prints the id, so a scripted run can be continued interactively. `--no-save` turns saving off.
- Large tool outputs saved by truncation live next to the log, in `.heaw/sessions/<id>/outputs/`.
- **Linked to what it produced.** The header records the commit the session started from and whether there were uncommitted changes (`git`), and the session's `intent` (`--intent build`, `explore`, `ask`, …). A `link` event records each pull request a run opened (URLs in the output of tools named `create_pull_request` / `create_merge_request`, or of `gh pr create` / `glab mr create`) and each commit it made (`HEAD` is read at the start of every run that can run commands, and `base..HEAD` at its end, ignoring commits older than the run). Link events come before `run.end`, so traces attach them to the run. The environment block tells the agent its session id, so a pull request can name it. `heaw sessions [--json]` lists sessions with intent, runs, cost, pull requests and commits: the join between agent work and what happened to it (merged, survived in main, caused an incident), which is what first-pass success and survival rates are computed from.
- **Rewind.** Before a file tool (any `write` tool with a path subject) changes a file for the first time in a run, its content is kept (files over 10 MB are listed but not kept). `/rewind [n]` (`Session.rewind`) puts the files of the last n runs that changed files back as they were and removes files they created; a sub-agent's changes belong to its parent's run. Changes made by commands are not undone. The model is told with the next input. Kept in memory: a resumed session cannot rewind runs from before the resume.
- The todo list is part of the session (the `todo_write` calls in the history), so a resumed chat shows it again. Compaction (M5) must keep the latest list.

### 4.14 Observability

- The session log is the base trace: every model call, tool call, approval and sub-agent run with timings and usage.
- **Usage and cost** per model call, run and session, from list prices in the model catalog or `models[…].pricing` (USD per million tokens; cached input at its own price). A catalog price applies only to that exact model or a dated version of it, never to a family, since `gpt-5.4` and `gpt-5` cost different amounts. Long-context surcharges are not modelled. Without a price, costs are shown as unknown, with how to set one. `/cost`, the status bar and the `heaw run` summary show it.
- Optional **OpenTelemetry** traces over OTLP/HTTP (JSON), following the GenAI semantic conventions, so Jaeger, Langfuse, Phoenix, Grafana Tempo and similar show them without configuration. Spans: `invoke_agent <agent>` per run (`gen_ai.agent.name`, `gen_ai.conversation.id`), `chat <model>` per model call (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `heaw.cost_usd`), `execute_tool <tool>` per tool call (`gen_ai.tool.name`, `gen_ai.tool.call.id`, `heaw.tool.status`). A sub-agent's run is a child of the `delegate` call that started it. Approvals, compaction, hook interventions and errors are span events. Prompts, answers and tool arguments and results are recorded only with `captureContent`.
- **What went wrong:** `session_report` (§4.8) condenses a saved session for the agent, so `/retro` can turn its failures into harness changes.
- **Where the tokens go:** `/cost` (`Session.usageBreakdown`) shows the number of model calls and the largest request, the tools whose results fill the conversation (every later request resends them), and calls repeated with the same arguments, the usual causes of rising cost. Resumed sessions rebuild it from the log.
- Configured by the standard variables (`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`) or `telemetry` in `heaw.config.ts`; the variables win. The exporter is built in (no OpenTelemetry SDK dependency): spans are batched, sent every two seconds and on exit, and an unreachable collector never fails a run; heaw prints why sending failed when it exits.
- **Redaction**: secret values never reach session logs or traces. Secrets are the values of every environment variable the config refers to (`env('NAME')`, `${NAME}` in `.mcp.json`) and of every variable whose name looks like a secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `PAT`), at least 8 characters long; they are replaced by `[redacted]`, in JSON-escaped form too.

### 4.15 CLI

| Command | Purpose |
|---|---|
| `heaw` | Start interactive chat in the current project |
| `heaw run "<prompt>"` | Non-interactive run; `--json` streams events as JSONL; `--allow`, `--mode`, `--model` flags |
| `heaw resume [id]` | Resume a session (picker if no id) |
| `heaw init` | Scaffold the project layer; then `/setup` in the chat configures it with the user |
| `heaw models` | The selected model and where it was chosen, its context window, capabilities and price; the configured providers; the models with built-in prices |
| `heaw mcp …` | Manage MCP servers: `search`, `install`, `add`, `list`, `test`, `login`, `logout`, `remove` (§4.5) |
| `heaw eval [filter]` | Run evals (§4.16): `--trials`, `--docker`, `--judge-model`, `--keep`, `--json`, `--compare <report or latest>` |
| `heaw eval add <name> --from-session <id>` | Turn a session into a regression case (`--check`, `--judge`) |
| `heaw eval compare <before> <after>` | Compare two reports; exit 1 when a case got worse |
| `heaw sessions` | Saved sessions with intent, cost, and the pull requests and commits they produced (`--json`) |

`heaw -c` continues the most recent conversation. The chat, `resume` and `run` share the agent flags: `--model`, `--mode`, `--allow`, `--deny`, `--no-tools`, `--no-save`, `--max-turns`.

In-chat slash commands (M3): `/help`, `/clear` (new conversation), `/model [provider:model]` (switch models, history stays), `/mode [mode]`, `/tools`, `/mcp [reload | login <server>]` (M6), `/permissions`, `/cost` (tokens, cost, context), `/compact [focus]` (M5), `/agents` and `/skills` (M7), `/rewind [runs]` (§4.13), `/setup [notes]`, `/plan <task> | go | off`, `/retro [session] [notes]` and `/reload` (§4.8), `/exit`. A text part that repeats an earlier one of the same response word for word (GPT-5 models can send a progress message and then the same text as their final answer) is shown once. The status bar shows tokens, cost and how full the context window is (`ctx 42%`, yellow from 70%). `heaw run` and the chat also take `--max-cost <usd>`, `--max-minutes <n>` and `--intent <label>`.

Keys: Enter sends · `\` then Enter for a new line · ↑/↓ earlier messages · Tab completes a command · Esc interrupts · Shift+Tab cycles default → accept-edits → read-only (bypass only via `/mode`, on purpose) · Ctrl+C clears the input, interrupts, or exits when pressed twice · Ctrl+D exits.

Built with **Ink** (React for terminals): finished items render once above a live area (streaming text, running tools, the input); Markdown is rendered with `marked-terminal`. The live area must stay shorter than the terminal: Ink cannot erase lines that scrolled off screen, so a taller live area prints a new copy on every update. Streaming text therefore moves out of the live area paragraph by paragraph (never splitting a code block), and an unfinished paragraph that is still too tall shows only its last lines until it is complete. `test/cli/terminal-overflow.test.tsx` checks this in an emulated 80×15 terminal (`@xterm/headless`). The whole live area is fitted to the rows there are (`live-area.ts`): running labels are cut to one line, and when it is still too tall the approval preview gets shorter, then delegate calls lose their progress lines, then sub-agents' running calls are summed up in one line ("… 3 more calls running"), then the oldest running lines are left out; approval requests always stay. Four parallel sub-agents with an approval prompt took 22-26 rows in a terminal of about 22 before. The approval prompt shows what the call would do (the command, the new file content, or the removed and added lines of an edit) with options yes / yes for this session / no / no with feedback for the model.

Keyboard input goes through one subscription owned by the chat root; components register with it in a layout effect. Ink's own `useInput` subscribes in a passive effect, which React may run a moment after a component appears, and a key pressed in that gap (a quick "y" on a prompt, typing ahead) would be lost.

`todo_write` calls render as a checklist under the tool line. The status bar shows MCP servers (`mcp 2/3`, yellow when one failed or needs a login).

A sub-agent's work starts with a line naming it and its task; its tool calls follow, indented and labelled with its name, and its streaming text stays hidden. Sub-agents running at the same time get their own colors, and namesakes are numbered (`ui-builder 1`, `ui-builder 2`). Finished items leave the live area even while an earlier item still runs, so a `delegate` call whose sub-agent works for minutes does not hold back the lines after it: before, two parallel sub-agents filled a live area taller than the terminal and every spinner frame printed it again. The running `delegate` line shows its sub-agent's progress instead (`ui-builder 2 · 14 calls · edit_file …`, matched by the `callId` of `subagent.start`) and is printed for good with its duration when the sub-agent is done. `test/cli/terminal-overflow.test.tsx` checks this too. An approval prompt from a sub-agent says which one asks. `heaw run` prints `[agent] name: task`, the sub-agent's tool lines prefixed with `[name]`, and `[agent] name finished · turns · cost`.

Coming later: collapsible tool output.

### 4.16 Evals

```yaml
# evals/fix-failing-test.yaml
name: fix-failing-test
fixture: ./fixtures/broken-math      # copied into a fresh temp workspace per trial
prompt: The test suite fails. Fix it.
trials: 3
checks:
  - command: npm test
    expectExitCode: 0
  - judge: The fix only changes src/math.ts and keeps the public API.
```

`heaw eval` runs each case N times, then reports pass rate, tokens, cost and duration as a table and a JSON report in `.heaw/evals/`, so harness or model changes can be compared objectively. The user guide is [docs/evals.md](evals.md).

- **Checks:** `command` (exit code), `file` (exists, or contains a text), `answerContains` (the final answer), `judge` (a model reads the task, one criterion, the final answer and the `git diff` of the trial and answers `{"pass", "reason"}`), `maxTurns` (what the task should cost, apart from the hard limit in `limits`). A trial passes when every check passes and the run ended on its own (`end_turn`).
- **Hidden checks:** a `command` check can name `files`, a folder copied into the workspace before the command runs (replacing files of the same name): tests the agent never saw. An agent that sees the test can make that test pass, by editing it or by fixing only the value it uses; what decides whether a case passes is therefore kept outside the fixture. The agent's diff for the judge is taken before any check runs, so check files and build output are not counted as its changes.
- **Why a trial failed:** every trial keeps its steps in the report (each tool call, failures, what heaw told the agent, what the agent said; the lines of `session_report`, §4.8) and its final answer. The checks say that a trial failed; the steps say why.
- **Isolation:** each trial gets a fresh temporary folder with the fixture, committed to a new git repository so the judge's diff shows exactly the agent's changes; an optional `setup` command runs first. Trials run one after another. The workspace follows the project's (`--docker` forces a container), the mode defaults to `accept-edits`, or `bypass` in a container. Nobody approves anything, as in `heaw run`.
- **What a trial gets from the project:** model, tools, rules, hooks, limits, agents and skills. Not: MCP servers (they act outside the folder), session saving, the tools that look at the project itself (`check_config`, `session_report`: the trial's folder is another project), or the project's AGENTS.md: instructions come from the fixture, which stands for the project the agent works on. A case's `allow` rules count as approvals given in advance, so a case can also approve what always asks (`finish_plan`, to evaluate plan mode from start to end).
- **What a case changes:** `deny` adds deny rules, `agents: true` adds the fixture's own `.heaw/agents/` (loaded with the fixture as the personal folder too, so no one's personal agents get in), and `contextWindow` wraps the model with a smaller window (and at most a quarter of it for output), so a short task reaches compaction. The checks `called: <tool>` (at least `n` calls, sub-agents included) and `compactions: <n>` make sure a case tests what it is about: that the browser was used, that sub-agents ran, that the history was compacted.
- **Run on GitHub:** the manual `Evals` workflow runs the suite with the trials and filter given, keeps the report as an artifact, and compares with a committed `evals/baseline.json` when there is one, failing when a case got worse.
- **Judge:** the agent's model by default, `--judge-model` for another; its cost is reported apart from the agent's.
- Exit code 0 when all trials passed, 1 otherwise, 2 when there is nothing to run, so `heaw eval` can gate CI.
- **From a mistake to a regression case:** `checkout: <commit>` instead of `fixture` clones the case's own repository at that commit for each trial, without a remote, so a push cannot reach the real repository. `heaw eval add <name> --from-session <id>` writes such a case from a saved session: its starting commit and first message, with `--check` / `--judge` checks or an empty list to fill in. It is the "never the same mistake twice" loop: the session that went wrong becomes the test that the harness change fixes it.
- **Regression detection:** `--compare <report|latest>` and `heaw eval compare` show each case's pass rate, turns, tokens, cost and time before and after, marked better, worse, same, new or removed. The same compares two models (`--model`), with the judge kept the same (`--judge-model`; a report names its judge, and a comparison of reports with different judges says so).
- **heaw's own suite** is in `evals/` of this repository, with the root `heaw.config.ts` (no hooks, so it measures the harness as it comes): thirteen small cases without dependencies, most of them a failure seen in real sessions in miniature (one edit per model call, a check that needs a missing tool, an answer from a folder listing, an unfinished plan, plan mode, tests that contradict each other). Each case has a reference solution, and `test/evals/suite.test.ts` runs every case without a model: it must pass with the solution and fail with nothing done, so a case that cannot be passed, or cannot fail, does not reach a paid run.

## 5. Project configuration

`heaw.config.ts` — typed, can import custom tools and hooks directly. Loaded with `jiti`; its `import ... from 'harness-engineered-agentic-workflow'` is pointed at the running heaw, so a project does not need the package installed (installing it as a dev dependency only adds editor type checking). Every setting is validated, and errors name the file and the setting.

Credentials are never written into config: `env('NAME')` refers to an environment variable and is read only when that provider is actually used, so an unused provider with a missing variable does not get in the way. A missing variable is reported with the setting that needs it. Built-in provider names (`azure`, `openai`, …) fall back to their usual environment variables; custom names (`azure-eu`, `lmstudio`) never do, so a second resource cannot silently use the first one's key.

The project root is found like git finds a repository: the nearest directory upwards with a heaw config file or `.heaw/`, else the git root, else the current directory (the personal `~/.heaw/` never makes the home directory a project). Tools, sessions and `.env` all use the project root, so heaw behaves the same from any subfolder.

```ts
import { defineConfig, env } from 'harness-engineered-agentic-workflow';
import { searchTickets } from './.heaw/tools/search-tickets.js';

export default defineConfig({
  model: 'azure:my-gpt5-deployment',
  providers: {
    azure: { resourceName: env('AZURE_RESOURCE_NAME'), apiKey: env('AZURE_API_KEY') },
    lmstudio: { type: 'openai-compatible', baseURL: 'http://localhost:1234/v1' },
  },
  workspace: { type: 'local' },   // or { type: 'docker', image: 'node:24', network: 'none' }
  toolsets: ['fs', 'shell', 'web', 'todo', 'http', 'mcp', 'agents', 'skills'],
  tools: [searchTickets],
  mcpServers: {
    tracker: { command: 'npx', args: ['-y', '<some-mcp-server>'], env: { TOKEN: env('TRACKER_TOKEN') } },
    docs:    { url: 'https://example.com/mcp', headers: { Authorization: env('DOCS_TOKEN', { prefix: 'Bearer ' }) } },
  },
  http: {
    apis: { 'https://api.example.com/v1': { headers: { Authorization: env('EXAMPLE_TOKEN') } } },
  },
  permissions: {
    mode: 'default',
    allow: ['run_command(npm test*)'],
    deny: ['read_file(**/.env)', 'read_file(**/.env.!(example))'],
  },
  hooks: {
    async beforeStop({ workspace }) {
      const r = await workspace.exec('npm test', { timeoutMs: 300_000 });
      if (r.exitCode !== 0) return { continue: true, feedback: `Tests still fail:\n${r.output}` };
    },
  },
  limits: { maxTurns: 100, maxCostUsd: 5 },
  subagents: { maxDepth: 1, maxParallel: 4 },
});
```

Resolution order, lowest to highest: built-in defaults → `~/.heaw/config.ts` (global) → project `heaw.config.ts` → environment variables (`HEAW_MODEL`, `HEAW_SHELL`) → CLI flags. Permission rules and tools from all levels are combined; the highest level that sets a mode wins.

Implemented in M4: `model`, `providers`, `models` (capability corrections), `workspace.shell`, `toolsets`, `tools`, `permissions`, `limits.maxTurns`, `sessions.save`; in M5: `hooks`, `limits.maxTokens` / `maxCostUsd` / `maxMinutes`, `context.compactAt`, `models[…].pricing`; in M6: `mcpServers`, `http.apis`; in M7: `subagents` (`maxDepth`, `maxParallel`, `limits`), with agents and skills read from `.heaw/agents/` and `.heaw/skills/`. In M8: `workspace.type: 'docker'` with `image`, `network`, `cpus`, `memory`, `env`, `git.tokenEnv` / `git.username` and `command`; settings for the other workspace type are rejected rather than ignored. In M9: `telemetry` (`endpoint`, `headers`, `serviceName`, `captureContent`), `verifyChanges` and `reasoningEffort`. The default toolsets are all built-in ones (`fs`, `shell`, `web`, `todo`, `http`, `mcp`, `agents`, `skills`); `http` adds its tool only when APIs are configured, `skills` only when there are skills. `heaw init` also creates `.heaw/agents/reviewer.md`, a read-only reviewer.

Project layout created by `heaw init`:

```
my-project/
├── heaw.config.ts
├── AGENTS.md
├── .env.example
├── .heaw/
│   ├── agents/          # named agent definitions (*.md)
│   ├── skills/          # <name>/SKILL.md
│   ├── tools/           # custom tools (*.ts)
│   └── sessions/        # gitignored
└── evals/
```

A complete setup for a software project that reads user stories from Jira and opens pull requests on GitHub ships as `examples/github-jira/`: both MCP servers, a Docker workspace that can push, permission rules, a test + lint `beforeStop` hook, an `implement-story` skill, a read-only `reviewer` agent, a script that implements every ready story, and a README on token scopes and branch protection. `examples/` also has a coding agent with hooks and evals, a customer support agent without shell or files, and library scripts; `test/examples.test.ts` loads them all, and they are type-checked against the source.

## 6. Repository layout (this repo)

Single npm package for v1, with internal folders mirroring the layers so it can be split later if needed.

```
harness-engineered-agentic-workflow/
├── src/
│   ├── core/            # loop, messages, events, context, permissions, hooks, sessions, agents
│   ├── providers/       # ModelClient interface impls: ai-sdk adapter, catalog, scripted
│   ├── tools/           # built-in toolsets
│   ├── mcp/
│   ├── skills/
│   ├── workspace/       # local, docker
│   ├── config/          # defineConfig, env(), loader, validation
│   ├── observability/   # usage/cost, otel
│   ├── evals/
│   ├── cli/             # Ink app, commands
│   ├── engine.ts        # createEngine: wires the layers together
│   ├── project.ts       # loadProject / createProjectEngine: a project as `heaw` sets it up
│   └── index.ts         # public library API
├── examples/            # github-jira, coding-agent, business-agent, library
├── evals/               # heaw's own eval suite: cases, fixtures, hidden checks, solutions (§4.16)
├── heaw.config.ts       # heaw's own setup, used by the eval suite
├── test/
├── docs/               # DESIGN.md, configuration.md (reference), evals.md
├── .devcontainer/  Dockerfile
├── LICENSE (MIT)  README.md  CONTRIBUTING.md  CHANGELOG.md (written by changesets)
```

## 7. Library API

```ts
import { createEngine } from 'harness-engineered-agentic-workflow';

const { items: agents } = await loadAgentDefinitions({ projectRoot, heawHome });
const engine = await createEngine({ model: 'azure:gpt-5.4', agents });
const session = engine.session();                        // or engine.resume(id)

for await (const event of session.send('Fix the failing test')) {
  if (event.type === 'text.delta' && !event.parentAgentId) process.stdout.write(event.text);
  if (event.type === 'approval.request') {
    session.approve(event.requestId, { allow: true, scope: 'once' });
  }
}

// A fixed workflow in code:
const plan = await engine.runAgent('planner', 'Plan the feature in ISSUE.md');
await engine.runAgent('implementer', plan.text);
const review = await engine.runAgent('reviewer', 'Review the working tree diff');
```

A script that should behave exactly like `heaw run` in a project (config files, AGENTS.md, `.mcp.json` and its logins, agents, skills, the configured workspace, saved sessions, redaction, telemetry) uses `createProjectEngine({ cwd })`, or `loadProject` to see and change the options first. The CLI is built on the same function.

Scripts can also call tools directly, without the model. Permission rules apply, and `ask` resolves as in `heaw run` (deny unless allowed in the call options):

```ts
const stories = await engine.callTool('mcp__jira__jira_search', {
  jql: 'project = PROJ AND status = "Ready for Dev"',
});

for (const story of parseStories(stories.output)) {   // one at a time: same working folder
  await engine.runAgent('main', `Implement ${story.key}`, {
    allow: ['run_command(git push*)', 'mcp__github__create_pull_request'],
  });
}
```

Also exported: `runEvals` / `loadEvalCases` / `formatEvalReport` (§4.16), `OtelTracer` and `Redactor` (§4.14), `DockerWorkspace` and `LocalWorkspace`, `JsonlSessionStore`, `McpManager`, `defineTool`, and `ScriptedModelClient` for testing code built on the engine.

## 8. Security model

Main threats and mitigations:

| Threat | Mitigation |
|---|---|
| Prompt injection via tool output (web pages, files, MCP results) | Permission gating on side effects; strict defaults; network `allowedHosts`; Docker workspace with `network: none` |
| Destructive commands | `ask` by default for write/execute; deny rules; `bypass` warns outside Docker |
| Secret leakage | Secrets only via env; redaction in logs/traces; default deny rule for `.env*` reads |
| Untrusted MCP servers | MCP servers are code you run — explicit config only; their tools default to `ask` |
| Runaway cost / loops | Turn, token, cost and time limits for agents and sub-agents |
| An agent loosening its own guardrails, or planting code that runs later outside its sandbox | Protected paths (`heaw.config.*`, `.mcp.json`, `.heaw/`, `.git/`) are always asked about; read-only in the Docker workspace (§4.10) |
| Prompt injection persisting through memory | Every memory note is asked about (§4.9) |
| Rules bypassed by rephrased commands | Defense in depth: branch protection, least-privilege tokens, Docker workspace (§4.10) |
| MCP OAuth token theft | Tokens stored per user outside the project with user-only permissions; never logged |

## 9. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 22.12 (developed on 24 LTS), ESM only |
| Language | TypeScript 6, `strict` (TypeScript 7 once typescript-eslint supports it) |
| Package manager | npm |
| Schemas | zod |
| Providers | Vercel AI SDK provider packages (`@ai-sdk/provider` + `@ai-sdk/*`) |
| MCP | `@modelcontextprotocol/sdk` |
| CLI | Ink (TUI), commander (arguments) |
| Config loading | jiti |
| Build | tsdown |
| Tests | vitest (+ scripted provider) |
| Lint/format | ESLint (typescript-eslint), Prettier, dependency-cruiser |
| Releases | changesets → npm |
| CI | GitHub Actions, matrix: Windows, macOS, Linux |

## 10. Testing strategy

- **Unit tests** for permissions matching, context compaction, config validation, path handling (Windows and POSIX).
- **Engine tests with the scripted provider** — deterministic scenarios: tool calls, errors, approvals, hooks, sub-agents, aborts.
- **Workspace tests** for local (all OSes in CI) and Docker (Linux CI).
- **Live provider smoke tests** — opt-in, run when API keys are present.
- **Evals** — the end-to-end quality signal (§4.16): `npm run eval` runs heaw's own suite with a real model, before and after a change to prompts, tool descriptions or the loop. The cases themselves are tested without a model in the unit tests.

## 11. Build order

Each milestone ends with something runnable.

| # | Milestone | Result |
|---|---|---|
| M0 | Repo foundation: tooling, CI, license, README, contributing | Empty package builds and tests on all OSes |
| M1 | Engine skeleton: messages, events, `ModelClient`, AI SDK adapter, model catalog, scripted provider, loop without tools, minimal `heaw run` | Talk to any provider from the terminal |
| M2 | Tools and safety: tool system, `fs` + `shell`, local workspace, permission engine, approvals, output truncation | Agent can read, edit and run commands safely |
| M3 | CLI chat: Ink UI, streaming, approval prompts, slash commands, sessions + resume | Usable interactive agent |
| M4 | Project layer: config loader, `env()`, instruction layering, environment block, `heaw init` | Per-project setup |
| M5 | Hooks and context: hook bus, compaction, usage/cost, limits | Long tasks and verification loops |
| M6 | Integrations: MCP client (stdio, HTTP, OAuth), `web`, `http`, `todo` | Connect GitHub, Jira and other services |
| M7 | Multi-agent and skills: agent definitions, `delegate`, skills | Sub-agents and on-demand knowledge |
| M8 | Containers: Docker workspace with credential passthrough, Dockerfile, dev container | Isolated execution, including `git push` |
| M9 | Quality and release: eval runner, OpenTelemetry, examples (incl. `examples/github-jira`), docs, publish **v1.0.0** | Public release |

## 12. Roadmap (after v1)

Web UI · Amazon Bedrock and other providers without an OpenAI-compatible API · built-in `web_search` (pluggable backends or provider-native search) · cloud workspaces (E2B, Daytona, Modal) · handoffs and agent teams · parallel tasks in separate git worktrees (e.g. several stories at once) · `heaw init --preset <name>` (e.g. `github-jira`) · argument-level permission rules for MCP tools · OS keychain storage for tokens · SSH agent forwarding into Docker · memory beyond notes (search, per-user) · rewind for commands and after a resume · OS-level sandboxing · JSON/YAML config and shell-command hooks · fallback models · expose the agent as an MCP server · A2A protocol.

## 13. Decisions

| Question | Decision |
|---|---|
| CLI name | `heaw` |
| Web search | Not built in for v1; added per project through an MCP server (§4.4). Built-in search is on the roadmap. |
| Session storage | Project folder, `.heaw/sessions/`, gitignored by `heaw init` (§4.13) |
| GitHub home | [DaDozlov/harness-agent](https://github.com/DaDozlov/harness-agent) |
| OpenTelemetry | A built-in OTLP/HTTP JSON exporter of about 400 lines instead of the OpenTelemetry SDK: no dependencies, and the GenAI conventions are applied in one place (§4.14) |
| Redaction | By value, from the variables the config reads and secret-looking names, so a token is caught wherever it appears (tool output, a command, an error) |
| Eval trials | Instructions from the fixture, no MCP servers, sessions not saved; the judge sees the git diff of the trial (§4.16) |
| Eval checks | What decides a case is kept outside the fixture and copied in after the run, and every case of heaw's suite is run without a model against a reference solution: an eval that can be passed by editing the test, or cannot be passed at all, measures nothing (§4.16) |
| Scripts and the CLI | One setup function, `loadProject`, so a script with `createProjectEngine` runs as `heaw run` would (§7) |
| Harness self-protection | Writes to heaw's own files and `.git/` always ask, in every mode; read-only mounts in Docker. Approvals still work, so the agent can maintain them with the user's consent (§4.10) |
| Memory | A plain Markdown file of dated notes, each one asked about; no embeddings or search in v1 (§4.9) |
| Session linkage | Recorded by the harness, not left to the model: the starting commit, commits since the run's `HEAD`, pull request URLs from the tools that create them (§4.13) |
| Rewind | File-tool changes only, kept in memory per run; commands' changes need git (§4.13) |
| Going in circles | Detected by the same failure repeating and by file contents coming back, not by counting edits, which batched edits of one file would trip (§4.1) |
| Improving the harness | The agent proposes changes from a condensed session log (`/retro`), the user picks; nothing changes the harness by itself (§4.8) |
