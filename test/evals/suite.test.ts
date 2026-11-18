import { existsSync } from 'node:fs';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { type EvalCase, loadEvalCases } from '../../src/evals/cases.js';
import { runEvals, type TrialResult } from '../../src/evals/runner.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { LocalWorkspace } from '../../src/workspace/local.js';

// heaw's own eval suite (evals/README.md). A case is only worth running against a model when a
// correct result passes it and doing nothing fails it; each case has a reference solution in
// evals/solutions/<name>/ to show both. Decoys in evals/decoys/<name>/<decoy>/ are tempting wrong
// results (the test edited instead of the bug, a stand-in for a missing tool): each must fail
// too, or the checks only tell a result from no result, not a right one from a wrong one.
const SUITE = resolve('evals');
const { items: cases, problems } = await loadEvalCases(SUITE);

/** The decoys of a case: their folders, each with `about.md` saying why it is wrong. */
async function decoysOf(name: string): Promise<Array<{ name: string; dir: string }>> {
  const root = join(SUITE, 'decoys', name);
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(root, entry.name) }));
}

/**
 * One trial with a model that only gives an answer. `result`: a solution or decoy folder whose
 * files are put into the workspace first (`delete.txt` lists paths it removes), and whose
 * `answer.md` is the model's answer; without one, the fixture as it is and "Done.".
 */
async function trial(evalCase: EvalCase, result?: string): Promise<TrialResult> {
  const files = result && join(result, 'files');
  // Paths the result removes, one per line (its files can only add or replace).
  const deleted =
    result && existsSync(join(result, 'delete.txt'))
      ? (await readFile(join(result, 'delete.txt'), 'utf8')).split('\n').filter(Boolean)
      : [];
  const answer =
    result && existsSync(join(result, 'answer.md'))
      ? await readFile(join(result, 'answer.md'), 'utf8')
      : 'Done.';
  // What only a run with a model shows (tool calls, compaction, questions) is not tested here.
  const checks = evalCase.checks.filter(
    (check) => !('called' in check || 'compactions' in check || 'disclosed' in check),
  );
  const report = await runEvals([{ ...evalCase, checks }], {
    model: 'scripted:test',
    trials: 1,
    // What a judge would say is not tested here: only what commands and texts can show.
    judge: new ScriptedModelClient([{ text: '{"pass": true, "reason": "not judged here"}' }]),
    createWorkspace: (dir) => new LocalWorkspace(dir),
    createEngine: async (workspace) => {
      if (files && existsSync(files)) {
        await cp(files, workspace.root, { recursive: true, force: true });
      }
      for (const path of deleted) {
        await rm(join(workspace.root, path.trim()), { recursive: true, force: true });
      }
      return createEngine({
        // One answer per message the case sends.
        model: new ScriptedModelClient(
          [evalCase.prompt, ...evalCase.followUps].map(() => ({ text: answer })),
        ),
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
        const solved = await trial(evalCase, join(SUITE, 'solutions', evalCase.name));
        expect(solved.checks.filter((check) => !check.passed)).toEqual([]);
        expect(solved.passed).toBe(true);

        const untouched = await trial(evalCase);
        expect(untouched.passed, 'the checks pass although nothing was done').toBe(false);

        for (const decoy of await decoysOf(evalCase.name)) {
          expect(existsSync(join(decoy.dir, 'about.md')), `${decoy.name}: about.md`).toBe(true);
          const wrong = await trial(evalCase, decoy.dir);
          expect(wrong.passed, `the checks pass the decoy "${decoy.name}"`).toBe(false);
        }
      }, 180_000);
    }
  });
});
