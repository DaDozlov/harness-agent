# Contributing

Open an issue before changing the design or the public API (`src/index.ts`, the config format, the CLI). The design is in [docs/DESIGN.md](docs/DESIGN.md).

## Setup

Node.js 22.12+ (development uses 24).

```bash
npm install
npm run check      # what CI runs: typecheck, lint, lint:deps, format:check, test
npm run dev        # rebuild dist/ on change; npm link for a global `heaw`
```

## Rules

- **Layers** (`npm run lint:deps`): `src/core/` imports nothing outside it; only `src/cli/` imports `src/cli/`; no devDependencies in `src/`; no cycles.
- **Style**: TypeScript strict, ESM, `.js` in relative imports; Prettier for code (Markdown by hand).
- **Tests**: vitest in `test/`, with the scripted model instead of real APIs and a temporary `HEAW_HOME`. Must pass on Windows, macOS and Linux.
- **Examples** are type-checked and loaded by `test/examples.test.ts`; keep them working.
- **Agent behaviour** changes (prompts, tool descriptions, the loop, built-in skills): run heaw's eval suite before and after, `npm run eval -- --trials 3` and then `npm run eval -- --trials 3 --compare latest`. It needs a model (`HEAW_MODEL` and its key in `.env`); what it costs and what the cases check is in [evals/README.md](evals/README.md).
- **Eval cases** (`evals/`) have a reference solution each; `test/evals/suite.test.ts` checks that every case passes with it and fails without.

## Releases

User-facing change? Add a changeset: `npm run changeset` (semver: patch = fix, minor = feature, major = breaking). Changesets on `main` open a "Version Packages" PR; merging it publishes to npm via trusted publishing. The release workflow runs once the repository variable `RELEASE_ENABLED` is `true` (setup steps at the top of `.github/workflows/release.yml`).
