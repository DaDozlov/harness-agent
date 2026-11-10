import { existsSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { type EvalCase, loadEvalCases } from '../../src/evals/cases.js';
import { runEvals, type TrialResult } from '../../src/evals/runner.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { LocalWorkspace } from '../../src/workspace/local.js';

// heaw's own eval suite (evals/README.md). A case is only worth running against a model when a
// correct result passes it and doing nothing fails it; each case has a reference solution in
// evals/solutions/<name>/ to show both.
const SUITE = resolve('evals');
const { items: cases, problems } = await loadEvalCases(SUITE);

/**
 * One trial with a model that only gives an answer. `solved`: the reference solution's files
 * are put into the workspace first, and its answer is the model's.
 */
async function trial(evalCase: EvalCase, solved: boolean): Promise<TrialResult> {
  const solution = join(SUITE, 'solutions', evalCase.name);
  const files = join(solution, 'files');
  const answer =
    solved && existsSync(join(solution, 'answer.md'))
      ? await readFile(join(solution, 'answer.md'), 'utf8')
      : 'Done.';
  const report = await runEvals([evalCase], {
    model: 'scripted:test',
    trials: 1,
    // What a judge would say is not tested here: only what commands and texts can show.
    judge: new ScriptedModelClient([{ text: '{"pass": true, "reason": "not judged here"}' }]),
    createWorkspace: (dir) => new LocalWorkspace(dir),
    createEngine: async (workspace) => {
      if (solved && existsSync(files)) {
        await cp(files, workspace.root, { recursive: true, force: true });
      }
      return createEngine({
        model: new ScriptedModelClient([{ text: answer }]),
        workspace,
        toolsets: [],
        interactive: false,
        git: false,
      });
    },
  });
  return report.cases[0]!.trials[0]!;
}

describe("heaw's eval suite", () => {
  it('loads: every case has its fixture, its check files and a reference solution', () => {
    expect(problems).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(9);
    for (const evalCase of cases) {
      expect(existsSync(evalCase.fixture ?? ''), `${evalCase.name}: fixture`).toBe(true);
      for (const check of evalCase.checks) {
        if ('command' in check && check.files) {
          expect(existsSync(check.files), `${evalCase.name}: ${check.files}`).toBe(true);
        }
      }
      expect(
        existsSync(join(SUITE, 'solutions', evalCase.name)),
        `${evalCase.name}: evals/solutions/${evalCase.name}`,
      ).toBe(true);
      // A limit on money and turns, so a trial that goes wrong ends.
      expect(evalCase.limits, evalCase.name).toMatchObject({
        maxTurns: expect.any(Number) as number,
        maxCostUsd: expect.any(Number) as number,
      });
    }
  });

  describe.concurrent('each case', () => {
    for (const evalCase of cases) {
      it(`${evalCase.name}: passes with its reference solution, fails with nothing done`, async () => {
        const solved = await trial(evalCase, true);
        expect(solved.checks.filter((check) => !check.passed)).toEqual([]);
        expect(solved.passed).toBe(true);

        const untouched = await trial(evalCase, false);
        expect(untouched.passed, 'the checks pass although nothing was done').toBe(false);
      }, 180_000);
    }
  });
});
