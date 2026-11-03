# GitHub + Jira: from story to pull request

The agent reads a Jira story, implements it on a branch, passes tests and lint, gets a review from a read-only sub-agent, and opens a pull request. People review and merge.

| File | |
|---|---|
| [`heaw.config.ts`](heaw.config.ts) | Docker workspace that can push, permission rules, limits, test + lint gate |
| [`.mcp.json`](.mcp.json) | GitHub and Atlassian MCP servers |
| [`.heaw/skills/implement-story/`](.heaw/skills/implement-story/SKILL.md) | The workflow, step by step |
| [`.heaw/agents/reviewer.md`](.heaw/agents/reviewer.md) | Read-only reviewer |
| [`scripts/implement-ready-stories.ts`](scripts/implement-ready-stories.ts) | Implements every ready story, unattended |

## Setup

1. Copy the files into your repository; adapt `AGENTS.md`, the hook's test command and `model`.
2. `cp .env.example .env` and fill it in.
3. **GitHub token** ([fine-grained](https://github.com/settings/personal-access-tokens/new)): this repository only; **Contents** and **Pull requests** read/write; short expiry. Ideally for a machine account with write (not admin) access.
4. **Jira**: `heaw mcp login atlassian` (Atlassian Cloud; an admin may need to enable the Rovo MCP server).
5. **Protect `main`** (Settings → Rules → Rulesets, no bypass): block force pushes and deletions, require a PR with one approval, require status checks.
6. Start Docker, or remove the `workspace` block to run commands locally.

Check with `heaw mcp list`.

## Use

```sh
heaw                     # then: Implement PROJ-123   (you approve push, PR and Jira comment)
heaw run "Implement PROJ-123" --allow "run_command(git push -u origin HEAD)" \
  --allow mcp__github__create_pull_request --allow mcp__atlassian__addCommentToJiraIssue
node --env-file-if-exists=.env scripts/implement-ready-stories.ts PROJ
```

## Safeguards

| Risk | Safeguard |
|---|---|
| Merge, delete, force-push | Denied in config; token without admin; branch ruleset |
| Untested changes | API file writes denied (changes go through git); test + lint gate; CI |
| Unasked pushes or PRs | `ask` rules; scripts allow only what they name |
| Secrets | `.env*` reads denied; container gets only `GH_TOKEN`; logs redacted |
| Harm to the machine | Commands run in the container |
| Agent loosening its rules | Config, `.mcp.json`, `.heaw/`, `.git/` protected and read-only in the container |
| Runaway story | 150 turns, $5, 60 minutes |

Rules are the first line; the token scope and the ruleset are what really hold. MCP tool names may change: `heaw mcp test <server>` lists them.
