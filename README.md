# heaw

heaw (harness-engineered agentic workflow) is an AI coding agent for your terminal and a TypeScript library for building your own agents. It works with any major model provider, asks before it changes files or runs commands, plans bigger tasks with you, and checks its work with your project's tests. Each project keeps its agent setup in a few files next to its code.

## Requirements

- Node.js 22.12 or newer, and Git
- A model: an API key for Azure OpenAI, OpenAI, Anthropic or Google, or a local Ollama
- Windows: Git for Windows (the agent runs commands in Git Bash)
- Optional: Docker, to run the agent's commands in a container

## Installation

Until the first npm release, install from source:

```bash
git clone https://github.com/DaDozlov/harness-agent.git
cd harness-agent
npm install
npm run build
npm link
```

This adds the `heaw` command.

## Usage

Set up a project once:

```bash
cd my-project
git init
heaw init --model azure:<deployment>    # or openai:<model>, anthropic:<model>, ollama:<model>
```

Copy `.env.example` to `.env` and fill in your API key, then start the chat:

```bash
heaw
```

1. Type `/setup`. The agent asks about the project step by step and writes its configuration.
2. Describe what you want to build. For bigger tasks it asks a few questions, writes `PLAN.md`, and builds it once you approve.
3. Answer approvals with `y` (yes), `a` (yes for this session), `n` (no) or `f` (no, with feedback).

In the chat: `/plan <task>` plans first, `/clear` starts a new conversation, `/rewind` undoes the last run's file changes, `/cost` shows the spend, `/retro` has the agent review a session and propose fixes for what went wrong, `/help` lists the rest. Esc interrupts, Ctrl+C twice exits.

| Command | |
|---|---|
| `heaw -c` | Continue the last conversation |
| `heaw run "<task>"` | Run one task without the chat, e.g. in CI |
| `heaw sessions` | List saved conversations |
| `heaw mcp search <name>` | Find tools (MCP servers) to connect |
| `heaw models` | Show the model and its price |

## Documentation

- [Configuration](docs/configuration.md): `heaw.config.ts`, permissions, hooks, MCP, Docker
- [Evals](docs/evals.md): measure how well the agent does your tasks
- [Examples](examples/): GitHub and Jira, coding agent, customer support, library use
- [Design](docs/DESIGN.md), [Contributing](CONTRIBUTING.md), license: [MIT](LICENSE)
