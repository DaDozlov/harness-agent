# Coding agent with checks and evals

| File | |
|---|---|
| [`heaw.config.ts`](heaw.config.ts) | Syntax check after each edit (`afterToolCall`), tests before finishing (`beforeStop`), a cost log (`sessionEnd`) |
| [`evals/`](evals/) | Two cases (fix a bug, add a feature) on the [`fixtures/stats`](evals/fixtures/stats/) project |

Use the config in a JavaScript project of yours (set `model`), or run the evals from this folder:

```sh
heaw eval --trials 1           # about $0.08 with gpt-5.4
heaw eval --compare latest     # after changing a prompt, hook or model
```

```
case              passed  tokens/trial  cost/trial  time/trial
add-median        1/1     40.6k         $0.0488     25.2s
fix-failing-test  1/1     37.5k         $0.0345     19.7s
```

See [docs/evals.md](../../docs/evals.md).
