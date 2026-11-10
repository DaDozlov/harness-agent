# Evals

Run the agent on fixed tasks several times and check the results, to measure a change to a prompt, hook, skill or model instead of guessing.

```sh
heaw eval                      # every case in evals/ (exit 0 = all passed, 1 = some failed)
heaw eval refund --trials 1    # cases matching "refund", one trial each
heaw eval --docker             # each trial in a container
heaw eval --judge-model azure:gpt-5.4
heaw eval --compare latest     # and how each case changed since the last run
heaw eval compare a.json b.json            # two saved reports; exit 1 if a case got worse
heaw eval add <name> --from-session <id> --check "npm test"
```

Also: `--keep` (keep trial folders), `--json`, and the agent flags (`--model`, `--mode`, `--allow`, `--max-minutes`, …). Reports are saved in `.heaw/evals/`.

## A case: `evals/<name>.yaml`

```yaml
fixture: ./fixtures/stats      # copied fresh for each trial (or: checkout: <commit>)
prompt: The test suite fails. Find the cause and fix it.
trials: 3
limits: { maxTurns: 30, maxCostUsd: 1 }
checks:
  - command: npm test          # exits 0 (expectExitCode to change)
  - command: node --test acceptance/stats.test.js
    files: ./checks/stats      # copied into the workspace first: tests the agent never saw
  - judge: The fix changes src/stats.js only; the tests are unchanged.
  - maxTurns: 10               # what the task should cost
```

| Field | |
|---|---|
| `fixture` / `checkout` | A folder to copy, or a commit of this repository to check out (no remote, so no pushes reach yours) |
| `prompt` | The task |
| `trials` | Runs per case (default 1; use 3+ to compare) |
| `setup` | Command before the agent starts, e.g. `npm ci` |
| `mode`, `allow`, `limits` | Per case; mode defaults to `accept-edits` (`bypass` in Docker). `allow` also gives approvals nobody is there to give, e.g. `finish_plan` |
| `deny` | Deny rules added for this case, e.g. a command the agent has to do without |
| `agents: true` | The fixture's own `.heaw/agents/` join the project's, e.g. a tester with its browser server |
| `contextWindow` | A smaller context window than the model's (at least 4,000), so a short task reaches compaction |
| `checks` | All must pass, and the run must finish on its own |

| Check | Passes when |
|---|---|
| `command: <cmd>` | The command exits 0 (or `expectExitCode`). With `files: <folder>`, the folder is copied into the workspace first, replacing files of the same name |
| `file: <path>` (`contains: <text>`, `exists: false`) | The file exists / contains the text / does not exist |
| `answerContains: <text>` | The final answer contains the text |
| `judge: <criterion>` | A model reading the task, the answer and the agent's `git diff` agrees |
| `maxTurns: <n>` | The run took at most `n` model turns |
| `called: <tool>` (`atLeast: <n>`) | The tool was called at least `n` times (default 1), sub-agents included, e.g. `delegate`, or a browser's screenshot tool |
| `compactions: <n>` | The history was compacted at least `n` times, so the case really tests work across a compaction |

Each trial runs in a fresh temp folder with the project's config, but without MCP servers, saved sessions or the tools that look at the project itself, and with the fixture's own AGENTS.md.

## Cases that can be trusted

A case is worth its cost when a correct result passes it and a wrong one fails it:

- **Prefer `command` checks**, and keep what decides in `files`, outside the fixture. An agent that sees the test can make that test pass (edit it, or fix only the value it uses); tests it never saw check the behaviour. Use `judge` for what no command can see, with the facts in the criterion.
- **Check what must not happen** too: `git diff --quiet HEAD -- test` (the tests are unchanged), `expectExitCode: 1` (a check that cannot pass honestly still fails).
- **Limit turns and cost** in `limits`, so a trial that goes wrong ends. `maxTurns` as a check, with a higher limit, tells a slow success from a failure.
- **Try the case without a model**: the checks should pass on a solution written by hand and fail on the untouched fixture. heaw's own suite does this in its tests ([evals/](../evals/README.md)).

## Why a trial failed

The table lists the checks that failed. The report file also has, for every trial, the final answer and its steps: each tool call, what failed, and what heaw told the agent.

```
[main t4] run_command npm run verify
   → error: exit code 1: 'acme-schemacheck' is not recognized as an internal or external command,
[main] says: Implemented the optional `phone` field, but `npm run verify` cannot fully pass here because…
```

## From a mistake to a regression case

```sh
heaw sessions                                    # find the session that went wrong
heaw eval add wrong-api --from-session 20261102-1415 --check "npm test" --judge "Uses the v2 client."
```

The case starts from the session's starting commit with its first message; uncommitted changes of that moment are not in it, so commit before a session whose task builds on them. Fix the harness (rule, hook, skill, AGENTS.md), then run `heaw eval wrong-api` until it passes. `/retro` proposes such cases.

## Comparing

```sh
heaw eval --trials 5                     # before the change
heaw eval --trials 5 --compare latest    # after
```

```
case              passed     turns/trial  tokens/trial   cost/trial         time/trial  change
add-median        2/3 → 3/3  9.3 → 7      40.6k → 31.2k  $0.0488 → $0.0371  41s → 33s   better
fix-failing-test  3/3 → 2/3  7 → 7.3      37.5k → 36.9k  $0.0345 → $0.0340  22s → 24s   worse
```

One trial in three is noise; a shift across several cases is a signal.

**Two models** compare the same way. Keep the judge the same for both runs, or `judge` checks are graded by different standards:

```sh
heaw eval --trials 3
heaw eval --trials 3 --model ollama:qwen3-coder:30b --judge-model azure:gpt-5.4 --compare latest
```

A local model needs its price (0) and its context window in `models` of `heaw.config.ts`, and `--max-minutes` bounds a trial where a turn takes a minute.

From code: `loadEvalCases`, `runEvals`, `formatEvalReport`, `compareReports`. Examples: heaw's own suite in [evals/](../evals/README.md), and [examples/coding-agent](../examples/coding-agent/).
