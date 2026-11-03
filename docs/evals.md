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

Also: `--keep` (keep trial folders), `--json`, and the agent flags (`--model`, `--mode`, `--allow`, …). Reports are saved in `.heaw/evals/`.

## A case: `evals/<name>.yaml`

```yaml
fixture: ./fixtures/stats      # copied fresh for each trial (or: checkout: <commit>)
prompt: The test suite fails. Find the cause and fix it.
trials: 3
limits: { maxTurns: 30, maxCostUsd: 1 }
checks:
  - command: npm test          # exits 0 (expectExitCode to change)
  - judge: The fix changes src/stats.js only; the tests are unchanged.
```

| Field | |
|---|---|
| `fixture` / `checkout` | A folder to copy, or a commit of this repository to check out (no remote, so no pushes reach yours) |
| `prompt` | The task |
| `trials` | Runs per case (default 1; use 3+ to compare) |
| `setup` | Command before the agent starts, e.g. `npm ci` |
| `mode`, `allow`, `limits` | Per case; mode defaults to `accept-edits` (`bypass` in Docker) |
| `checks` | All must pass, and the run must finish on its own |

| Check | Passes when |
|---|---|
| `command: <cmd>` | The command exits 0 (or `expectExitCode`) |
| `file: <path>` (`contains: <text>`, `exists: false`) | The file exists / contains the text / does not exist |
| `answerContains: <text>` | The final answer contains the text |
| `judge: <criterion>` | A model reading the task, answer and `git diff` agrees |

Prefer `command` checks; use `judge` for what a command cannot see. Each trial runs in a fresh temp folder with the project's config, but without MCP servers or saved sessions, and with the fixture's own AGENTS.md.

## From a mistake to a regression case

```sh
heaw sessions                                    # find the session that went wrong
heaw eval add wrong-api --from-session 20261102-1415 --check "npm test" --judge "Uses the v2 client."
```

The case starts from the session's starting commit with its first message. Fix the harness (rule, hook, skill, AGENTS.md), then run `heaw eval wrong-api` until it passes.

## Comparing

```sh
heaw eval --trials 5                     # before the change
heaw eval --trials 5 --compare latest    # after
```

```
case              passed     tokens/trial    cost/trial          change
add-median        2/3 → 3/3  40.6k → 31.2k   $0.0488 → $0.0371   better
fix-failing-test  3/3 → 2/3  37.5k → 36.9k   $0.0345 → $0.0340   worse
```

One trial in three is noise; a shift across several cases is a signal. From code: `loadEvalCases`, `runEvals`, `formatEvalReport`, `compareReports`. Example: [examples/coding-agent](../examples/coding-agent/).
