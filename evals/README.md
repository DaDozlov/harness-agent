# heaw's eval suite

Thirteen small tasks for the agent, each with checks that decide whether it did them right. They measure the harness (prompts, tool descriptions, the loop, built-in skills) with a model, where the unit tests in `test/` measure the code without one. Run it before and after a change to how the agent behaves, or to compare two models.

```sh
npm run eval                                 # all cases, with the model in HEAW_MODEL (.env)
npm run eval -- shared --trials 3            # the cases matching "shared", three trials each
npm run eval -- --trials 3 --compare latest  # and what changed since the last run
```

It builds heaw first and runs `heaw eval` in this repository, with the root [heaw.config.ts](../heaw.config.ts): no hooks, so the cases meet the harness as it comes. One pass of all thirteen cases with `azure:gpt-5.4` costs about $1.15 and takes about 9 minutes; `ui-tester` also needs Chrome. Reports go to `.heaw/evals/` (not committed). How evals work in general: [docs/evals.md](../docs/evals.md).

## The cases

| Case | The agent has to | Where it comes from |
|---|---|---|
| `fix-failing-test` | Find a bug one module away from the failing test and fix it there, not in the test or the caller | The basic loop: look, change, verify |
| `add-feature` | Add a function with a precise contract, and tests for it | The basic loop, with the fixture's conventions |
| `shared-helper` | Make about ten small changes in nine files, in at most 12 turns | A session where 49 edits took 49 model calls: 78 of its 100 turns |
| `missing-tool` | Do the work, then say that the project's check needs a tool that is not installed, without faking the tool or dropping the check | A session where a check that needed Maven sent the agent back 14 times |
| `answer-from-code` | Answer a question whose facts are spread over five files, and change nothing | Runs where a model described a project from its folder listing |
| `continue-plan` | Go on with a PLAN.md that has two steps left, told only "please continue" | A build that stopped at its cost limit; the next conversation knew nothing of the plan |
| `plan-and-build` | Switch to plan mode, write PLAN.md, and build every step once it is approved | Builds that stopped after single steps, and a model that asked for approval of a plan it had not written |
| `conflicting-tests` | Notice that two test files it may not change want different results, say so and stop | Agents trying variations of a fix that cannot work |
| `generated-code` | Follow a rule from AGENTS.md: change the source of a generated file and run the generator | Instructions of the project against the quick way |
| `ui-tester` | Add a field to a page whose stylesheet cuts it off, with the tests passing anyway; have the project's browser tester look and fix what it finds | The CRM, where the problems only the user caught were the ones a user sees. Needs Chrome |
| `denied-command` | Empty a folder and rebuild it while `rm` is denied, using the project's own clean script instead of fighting the rule | Agents trying variations of a refused command |
| `compaction` | Rename a field across a project bigger than the 16k context window given, keeping a database column, and finish after the history is compacted | Long builds that lost track after compaction |
| `sub-agents` | Build three independent helpers from a spec with three sub-agents at once, then run the whole suite | Plan steps run in parallel (`delegate` with files and a check) |

Not covered yet: reviews, approvals and MCP tools of the project.

## How a case is built

```
evals/
  shared-helper.yaml              the case: fixture, prompt, limits, checks
  fixtures/shop-pages/            what the agent gets, with its own AGENTS.md
  checks/shared-helper/           copied into the workspace after the agent has finished
  solutions/shared-helper/files/  a correct result (and answer.md, where the answer is checked)
```

- **Fixtures** are plain Node projects without dependencies (`node --test`), so a trial needs no install and runs anywhere Node 22 does. ESLint and Prettier leave them alone: they are what the agent works on, bugs included.
- **Checks** that decide are in `checks/`, not in the fixture: tests the agent has not seen, and scripts that look for what must not happen (a stand-in for a missing tool, a generated file edited by hand, a step dropped from the plan).
- **Solutions** show that the case can be passed. `test/evals/suite.test.ts` runs every case without a model, once with its solution (every check must pass) and once with nothing done (it must fail). It runs with the unit tests. A solution's `delete.txt` lists files it removes; the `called` and `compactions` checks need a real run and are left out there.
- **What a case can change** about the harness it meets: `deny` adds deny rules, `agents: true` adds the fixture's own `.heaw/agents/` (the tester of `ui-tester`, with its browser), and `contextWindow` makes the model's window smaller, so a short task reaches compaction.

To add a case: write the fixture, the checks and a solution, run `npm test -- suite`, then `npm run eval -- <name> --trials 3` and read the steps of the trials in the report: a case is ready when its failures are the agent's and not the case's.

## On GitHub

The `Evals` workflow (`.github/workflows/evals.yml`) runs the suite by hand from the Actions tab, with the trials and an optional filter as inputs. It needs the repository secrets `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` and the variable `HEAW_EVAL_MODEL` (e.g. `azure:gpt-5.4`). The report is kept as the run's artifact. With an `evals/baseline.json` in the repository, the run compares with it and fails when a case got worse: commit the report of a run you trust as the baseline, and replace it when a change made things better on purpose.

## Comparing models

Give both runs the same judge, and a local model a time limit per trial:

```sh
npm run eval -- --trials 3
npm run eval -- --model ollama:qwen3-coder:30b --judge-model azure:gpt-5.4 --max-minutes 15 --compare latest
```

A local model needs its price and context window in `models` of [heaw.config.ts](../heaw.config.ts), and Ollama has to serve that context (`OLLAMA_CONTEXT_LENGTH`).

All thirteen with gpt-5.4, one trial each, on 2026-11-10: 13/13, $1.15, 9 minutes. In `ui-tester` the agent added the email, had the tester look, read in its report that the entries were cut off, fixed the stylesheet and had it look again (8 to 12 turns, $0.15). `shared-helper` took 11 of its 12 turns, against 5 in the runs below: one to watch.

The first nine compared with a local model (`continue-plan` for gpt-5.4 after the fix the suite found, see below):

| Case | gpt-5.4, 3 trials | turns | qwen3-coder:30b, 1 trial | turns | why it failed |
|---|---|---|---|---|---|
| `fix-failing-test` | 3/3 | 6.3 | 0/1 | 16 | time limit |
| `add-feature` | 3/3 | 7 | 0/1 | 3 | response cut off (now retried) |
| `shared-helper` | 3/3 | 5 | 0/1 | 20 | changed what the helper prints; 20 turns |
| `missing-tool` | 3/3 | 7 | 0/1 | 11 | time limit, before telling the user |
| `answer-from-code` | 3/3 | 2.7 | 1/1 | 8 | |
| `continue-plan` | 3/3 (1/3 before) | 11.3 | 0/1 | 13 | time limit, two steps left |
| `plan-and-build` | 3/3 | 24.3 | 0/1 | 9 | time limit, no plan yet |
| `conflicting-tests` | 3/3 | 4.7 | 0/1 | 7 | the PC slept through most of the trial |
| `generated-code` | 3/3 | 7 | 0/1 | 20 | turn limit |
| Total | 25/27 before the fix, $1.86, 16 min | | 1/9, $0, 143 min | | |

gpt-5.4 does every case; the local model, at about a minute per turn on a desktop GPU, does the question and runs out of time on the rest. It is usable for questions and small changes, not for building.

What the suite found on its first runs:

- **In heaw:** a conversation that went on with a plan approved in an earlier one did a step and stopped, since only the approving conversation sent the agent on to the next step (`continue-plan`, 1/3, now 3/3). A response the local model server cut off ended the run instead of being asked again.
- **In the cases:** two judge criteria failed correct answers, such as "the tests passed, the schema check could not run". A criterion now gives the facts and says what fails.
- **In the runner:** a failed hidden test showed the end of a stack trace instead of the test and its assertion.
