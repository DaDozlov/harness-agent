# AGENTS.md

heaw: an agent harness for TypeScript and the `heaw` CLI. The design is in `docs/DESIGN.md`, the
user-facing settings in `docs/configuration.md`, evals in `docs/evals.md` and `evals/README.md`.

## Commands

- Install: `npm install` (Node 22.12+, development uses 24)
- Everything CI runs: `npm run check` (typecheck, lint, lint:deps, format:check, test)
- One test file: `npm test -- test/core/loop.test.ts`
- Build: `npm run build`; the CLI is then `node dist/cli.js`
- Eval suite against a real model: `npm run eval -- <case> --trials 3` (costs money; needs `HEAW_MODEL` and its key in `.env`)

## Rules

- Layers (`npm run lint:deps`): `src/core/` imports nothing outside it; only `src/cli/` imports `src/cli/`; no devDependencies in `src/`; no cycles.
- TypeScript strict, ESM, `.js` in relative imports. Prettier formats code; Markdown is written by hand.
- Tests use the scripted model (`src/providers/scripted.ts`), never a real API, and a temporary `HEAW_HOME`. They must pass on Windows, macOS and Linux.
- A change to how the agent behaves (prompts, tool descriptions, the loop, built-in skills): run the affected eval cases before and after, and say what changed.
- An eval case has a fixture, hidden checks and a reference solution; `test/evals/suite.test.ts` checks that it passes with the solution and fails with nothing done.
- User-facing change: add a changeset (`.changeset/*.md`).
- Docs say what the code does, with the reason; update `docs/DESIGN.md` and `docs/configuration.md` with the change.

## Security

- Never print, log or commit secrets; `.env` is not read.
- Do not weaken permission checks, protected paths, the secret filter for commands or `web_fetch`'s address checks without saying so plainly and why (`docs/DESIGN.md` §8).

## Git

- Commits, pushes and releases are the maintainer's. Do not commit, push or publish.
