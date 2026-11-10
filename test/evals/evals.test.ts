import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evalCommand } from '../../src/cli/commands/eval.js';
import { modelsCommand } from '../../src/cli/commands/models.js';
import type { ModelClient } from '../../src/core/model.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { loadEvalCases, parseEvalCase } from '../../src/evals/cases.js';
import { formatEvalReport, parseVerdict, runEvals } from '../../src/evals/runner.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { LocalWorkspace } from '../../src/workspace/local.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const PRICED = { pricing: { input: 10, output: 20 } };

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

/** A project with a fixture whose add() is broken, and a case that asks to fix it. */
async function evalProject(caseYaml: string) {
  const root = await tempDir();
  await mkdir(join(root, 'evals', 'fixtures', 'math'), { recursive: true });
  await writeFile(
    join(root, 'evals', 'fixtures', 'math', 'math.js'),
    'export const add = (a, b) => a - b;\n',
  );
  await writeFile(join(root, 'evals', 'fix-add.yaml'), caseYaml);
  await writeFile(join(root, 'heaw.config.ts'), "export default { model: 'scripted:test' };");
  return root;
}

const FIX: ScriptedResponse[] = [
  { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] },
  {
    toolCalls: [
      {
        name: 'write_file',
        args: { path: 'math.js', content: 'export const add = (a, b) => a + b;\n' },
      },
    ],
  },
  { text: 'Fixed: add now returns a + b.', usage: { inputTokens: 1_000, outputTokens: 100 } },
];

describe('eval cases', () => {
  it('reads a case, resolving the fixture next to it', () => {
    const evalCase = parseEvalCase(
      [
        'prompt: Fix add.',
        'fixture: ./fixtures/math',
        'trials: 2',
        'allow: ["run_command(node *)"]',
        'checks:',
        '  - command: node check.js',
        '  - judge: Only math.js changed.',
        '  - answerContains: a + b',
        '  - file: math.js',
        '    contains: a + b',
      ].join('\n'),
      '/project/evals/fix-add.yaml',
    );

    expect(evalCase).toEqual({
      name: 'fix-add',
      source: '/project/evals/fix-add.yaml',
      fixture: resolve('/project/evals/fixtures/math'),
      prompt: 'Fix add.',
      trials: 2,
      allow: ['run_command(node *)'],
      deny: [],
      agents: false,
      limits: {},
      checks: [
        { command: 'node check.js', expectExitCode: 0 },
        { judge: 'Only math.js changed.' },
        { answerContains: 'a + b' },
        { file: 'math.js', exists: true, contains: 'a + b' },
      ],
    });
  });

  it('explains unusable cases and filters by name', async () => {
    const root = await evalProject('prompt: Fix add.\nchecks:\n  - answerContains: a + b\n');
    await writeFile(join(root, 'evals', 'broken.yaml'), 'prompt: x\nchecks: []\n');

    const all = await loadEvalCases(join(root, 'evals'));
    const filtered = await loadEvalCases(join(root, 'evals'), 'nothing');

    expect(all.items.map((item) => item.name)).toEqual(['fix-add']);
    expect(all.problems).toEqual([
      expect.stringContaining('checks: add at least one check') as unknown,
    ]);
    expect(filtered.items).toEqual([]);
  });

  it('reads judge verdicts, also when wrapped in prose', () => {
    expect(parseVerdict('{"pass": true, "reason": "Only math.js changed."}')).toEqual({
      pass: true,
      reason: 'Only math.js changed.',
    });
    expect(parseVerdict('```json\n{"pass": false, "reason": "README changed too"}\n```').pass).toBe(
      false,
    );
    expect(parseVerdict('PASS: looks right').pass).toBe(true);
  });
});

describe('running evals', () => {
  it('runs each trial in a fresh copy of the fixture and grades it', async () => {
    const root = await evalProject('');
    const evalCase = parseEvalCase(
      [
        'prompt: The add function is wrong. Fix it.',
        'fixture: ./fixtures/math',
        'trials: 2',
        'checks:',
        '  - file: math.js',
        '    contains: a + b',
        '  - answerContains: a + b',
        '  - judge: Only math.js changed.',
      ].join('\n'),
      join(root, 'evals', 'fix-add.yaml'),
    );
    const judge = new ScriptedModelClient([
      { text: '{"pass": true, "reason": "Only math.js changed."}', usage: { inputTokens: 50 } },
      {
        text: '{"pass": false, "reason": "It also changed README.md."}',
        usage: { inputTokens: 50 },
      },
    ]);
    const seenDiffs: string[] = [];
    const scripts = [FIX, [FIX[0]!, { text: 'I could not fix it, sorry.' }]];

    const report = await runEvals([evalCase], {
      model: 'scripted:test',
      judge: {
        ...judge,
        id: judge.id,
        capabilities: judge.capabilities,
        stream: (request, signal) => {
          seenDiffs.push(
            String(
              request.messages[0]?.content[0] &&
                (request.messages[0].content[0] as { text: string }).text,
            ),
          );
          return judge.stream(request, signal);
        },
      },
      createWorkspace: (dir) => new LocalWorkspace(dir),
      createEngine: (workspace) =>
        createEngine({
          model: new ScriptedModelClient(scripts.shift()!, { capabilities: PRICED }),
          workspace,
          toolsets: ['fs'],
          interactive: false,
          permissions: { mode: 'accept-edits' },
          git: false,
        }),
    });

    expect(report).toMatchObject({ passed: 1, total: 2 });
    const [first, second] = report.cases[0]!.trials;
    expect(first?.checks).toEqual([
      { check: 'math.js contains "a + b"', passed: true },
      { check: 'the answer contains "a + b"', passed: true },
      { check: 'judge: Only math.js changed.', passed: true, detail: 'Only math.js changed.' },
    ]);
    expect(first?.passed).toBe(true);
    expect(first?.costUsd).toBeCloseTo(0.012);
    expect(second?.checks.filter((check) => !check.passed).map((check) => check.check)).toEqual([
      'math.js contains "a + b"',
      'the answer contains "a + b"',
      'judge: Only math.js changed.',
    ]);
    expect(seenDiffs[0]).toContain('-export const add = (a, b) => a - b;');
    expect(seenDiffs[0]).toContain('+export const add = (a, b) => a + b;');
    expect(seenDiffs[1]).toContain('Changes it made (git diff):\n(no changes)');
    expect(report.judgeUsage.inputTokens).toBe(100);
    expect(report.judgeModel).toBe(judge.id);
    // 3 turns, then 2: the table shows the mean.
    expect(formatEvalReport(report)).toMatch(
      /case\s+passed\s+turns\/trial\s+tokens\/trial\s+cost\/trial\s+time\/trial\nfix-add\s+1\/2\s+2\.5\s+/,
    );
    // What happened in a trial is kept with it: a failed one can be understood from the report.
    expect(first?.steps).toEqual([
      expect.stringMatching(/the user: "The add function is wrong\. Fix it\."$/) as unknown,
      '[main t1] read_file math.js',
      '[main t2] write_file math.js',
      '[main] says: Fixed: add now returns a + b.',
      expect.stringMatching(/run ended: end_turn · 3 turns/) as unknown,
    ]);
  });

  it('copies hidden check files in before a command, and can limit the turns', async () => {
    const root = await evalProject('');
    await mkdir(join(root, 'evals', 'checks'), { recursive: true });
    await writeFile(
      join(root, 'evals', 'checks', 'accept.mjs'),
      "import { add } from './math.js';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
    );
    // A failing test: the detail names the assertion, not the stack trace at the end.
    await writeFile(
      join(root, 'evals', 'checks', 'strict.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { add } from './math.js';",
        "test('adds big numbers', () => assert.equal(add(2, 3), 6));",
      ].join('\n'),
    );
    const evalCase = parseEvalCase(
      [
        'prompt: The add function is wrong. Fix it.',
        'fixture: ./fixtures/math',
        'checks:',
        '  - command: node accept.mjs',
        '    files: ./checks',
        '  - command: node --test strict.test.mjs',
        '  - judge: Only math.js changed.',
        '  - maxTurns: 2',
      ].join('\n'),
      join(root, 'evals', 'fix-add.yaml'),
    );
    expect(evalCase.checks[0]).toEqual({
      command: 'node accept.mjs',
      expectExitCode: 0,
      files: resolve(root, 'evals', 'checks'),
    });
    const prompts: string[] = [];
    const judge = new ScriptedModelClient([{ text: '{"pass": true}' }]);

    const report = await runEvals([evalCase], {
      model: 'scripted:test',
      judge: {
        id: judge.id,
        capabilities: judge.capabilities,
        stream: (request, signal) => {
          prompts.push((request.messages[0]?.content[0] as { text: string }).text);
          return judge.stream(request, signal);
        },
      },
      createWorkspace: (dir) => new LocalWorkspace(dir),
      createEngine: (workspace) =>
        createEngine({
          model: new ScriptedModelClient(FIX),
          workspace,
          toolsets: ['fs'],
          interactive: false,
          permissions: { mode: 'accept-edits' },
          git: false,
        }),
    });

    const [trial] = report.cases[0]!.trials;
    expect(trial?.checks).toEqual([
      { check: 'node accept.mjs exits 0', passed: true },
      {
        check: 'node --test strict.test.mjs exits 0',
        passed: false,
        detail: expect.stringMatching(/^exited 1: .*adds big numbers.*AssertionError/) as unknown,
      },
      { check: 'judge: Only math.js changed.', passed: true },
      { check: 'at most 2 turns', passed: false, detail: 'took 3' },
    ]);
    // The judge sees what the agent changed, not the files a check brought along.
    expect(prompts[0]).toContain('+export const add = (a, b) => a + b;');
    expect(prompts[0]).not.toContain('accept.mjs');
  });

  it("heaw eval runs the project's cases, prints a table, saves a report and fails when a trial fails", async () => {
    const root = await evalProject(
      [
        'prompt: The add function is wrong. Fix it.',
        'fixture: ./fixtures/math',
        'checks:',
        '  - file: math.js',
        '    contains: a + b',
        '  - answerContains: a + b',
      ].join('\n'),
    );
    const stdout = output();
    const stderr = output();
    const scripts = [[], FIX];
    const tools: string[][] = [];

    const code = await evalCommand(
      undefined,
      {},
      {
        cwd: root,
        env: { HEAW_HOME: join(root, 'home') },
        stdout,
        stderr,
        packageEntry: resolve('src/index.ts'),
        createEngine: (options) => {
          tools.push((options.tools ?? []).map((tool) => tool.name));
          return createEngine({
            ...options,
            // The scripted fix runs no command; the reminder to verify would ask for one.
            verifyChanges: false,
            model: new ScriptedModelClient(scripts.shift() ?? [], { id: 'scripted:test' }),
          });
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr.text).toContain('fix-add #1/1: passed');
    expect(stdout.text).toMatch(/fix-add\s+1\/1/);
    expect(stdout.text).toContain('1/1 trials passed · scripted:test');
    // A trial works in its own folder: the tools that look at this project are left out.
    expect(tools.at(-1)).toEqual([]);
    const reportPath = /Report: (.+)\n/.exec(stdout.text)?.[1];
    const report = JSON.parse(await readFile(resolve(root, reportPath!), 'utf8')) as {
      passed: number;
      cases: Array<{ trials: Array<{ steps: string[] }> }>;
    };
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.trials[0]?.steps).toContain('[main t2] write_file math.js');
    expect(await readFile(join(root, '.heaw', 'evals', '.gitignore'), 'utf8')).toBe('*\n');
    // The fixture itself is untouched: each trial works on a copy.
    expect(await readFile(join(root, 'evals', 'fixtures', 'math', 'math.js'), 'utf8')).toContain(
      'a - b',
    );
  });

  it('gives a trial the case’s deny rules, the fixture’s agents and a smaller context window', async () => {
    const root = await evalProject(
      [
        'prompt: The add function is wrong. Fix it.',
        'fixture: ./fixtures/math',
        "deny: ['run_command(rm *)']",
        'agents: true',
        'contextWindow: 16000',
        'checks:',
        '  - file: math.js',
        '    contains: a + b',
      ].join('\n'),
    );
    await mkdir(join(root, 'evals', 'fixtures', 'math', '.heaw', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'evals', 'fixtures', 'math', '.heaw', 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helps.\n---\nHelp.',
    );
    const seen: EngineOptions[] = [];

    await evalCommand(
      undefined,
      {},
      {
        cwd: root,
        env: { HEAW_HOME: join(root, 'home') },
        stdout: output(),
        stderr: output(),
        packageEntry: resolve('src/index.ts'),
        createEngine: (options) => {
          seen.push(options);
          return createEngine({
            ...options,
            verifyChanges: false,
            model: new ScriptedModelClient(seen.length === 1 ? [] : FIX, { id: 'scripted:test' }),
          });
        },
      },
    );

    const trial = seen.at(-1)!;
    expect(trial.permissions?.deny).toContain('run_command(rm *)');
    expect(trial.agents?.map((agent) => agent.name)).toContain('helper');
    expect((trial.model as ModelClient).capabilities.contextWindow).toBe(16_000);
    expect((trial.model as ModelClient).capabilities.maxOutputTokens).toBeLessThanOrEqual(4_000);
  });

  it('grades the tools a trial called and whether its history was compacted', async () => {
    const root = await evalProject('');
    const evalCase = parseEvalCase(
      [
        'prompt: The add function is wrong. Fix it.',
        'fixture: ./fixtures/math',
        'checks:',
        '  - called: write_file',
        '  - called: delegate',
        '    atLeast: 3',
        '  - compactions: 1',
      ].join('\n'),
      join(root, 'evals', 'fix-add.yaml'),
    );

    const report = await runEvals([evalCase], {
      model: 'scripted:test',
      judge: new ScriptedModelClient([]),
      createWorkspace: (dir) => new LocalWorkspace(dir),
      createEngine: (workspace) =>
        createEngine({
          model: new ScriptedModelClient(FIX),
          workspace,
          toolsets: ['fs'],
          interactive: false,
          permissions: { mode: 'accept-edits' },
          git: false,
          verifyChanges: false,
        }),
    });

    expect(report.cases[0]?.trials[0]?.checks).toEqual([
      { check: 'write_file called at least 1 time', passed: true },
      { check: 'delegate called at least 3 times', passed: false, detail: 'called 0 times' },
      { check: 'compacted at least 1 time', passed: false, detail: 'compacted 0 times' },
    ]);
  });

  it('heaw models shows what heaw knows about the model', async () => {
    const stdout = output();
    const root = await tempDir();

    await modelsCommand(
      { model: 'openai:gpt-5.4' },
      { cwd: root, env: { HEAW_HOME: join(root, 'home') }, stdout, stderr: output() },
    );

    expect(stdout.text).toContain('Model: openai:gpt-5.4 (from --model)');
    expect(stdout.text).toContain(
      'Price per million tokens: $2.50 input, $0.25 cached, $15.00 output',
    );
    expect(stdout.text).toContain('Providers: openai, azure, anthropic, google, ollama');
  });
});
