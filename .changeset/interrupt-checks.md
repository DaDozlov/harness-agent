---
'harness-engineered-agentic-workflow': patch
---

- Esc stops a run while its `beforeStop` check runs. The tester or reviewer a hook starts with `runAgent` gets the run's signal, and a hook that ignores the signal gets 1.5 seconds before the run stops without its result. Before, Esc did nothing until the tester was done, which could take minutes.
- The chat shows the agent a hook started while it works (`ui-tester is checking… (Esc to stop)`), not only after the hook returned.
- The hook templates of `heaw init` and `/setup` pass `signal` to `workspace.exec`, so Esc stops the tests too. Add `signal` to hooks written before: `async beforeStop({ workspace, signal }) { await workspace.exec('npm test', { signal }) }`.
- On Windows, a folder whose path names home by its short name (`C:\Users\NAME~1\…`, as `TEMP` does) no longer treats home as the project once `~/.heaw` exists.
