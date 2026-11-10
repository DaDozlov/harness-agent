import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeBreakdown } from '../../src/cli/chat/commands.js';
import { evalAddCommand } from '../../src/cli/commands/eval-add.js';
import { evalCompareCommand } from '../../src/cli/commands/eval.js';
import { formatSessions, sessionsCommand } from '../../src/cli/commands/sessions.js';
import type { EngineEvent } from '../../src/core/events.js';
import { UsageStats } from '../../src/core/usage-stats.js';
import { createEngine } from '../../src/engine.js';
import { parseEvalCase } from '../../src/evals/cases.js';
import { compareReports } from '../../src/evals/compare.js';
import { type EvalReport, runEvals } from '../../src/evals/runner.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { defineTool } from '../../src/tools/define.js';
import { LocalWorkspace } from '../../src/workspace/local.js';
import { collect, tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const GIT = [
  '-c',
  'user.name=Dev',
  '-c',
  'user.email=dev@example.invalid',
  '-c',
  'core.autocrlf=false',
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A project with one commit, and an uncommitted change when `dirty`. */
async function repo(dirty = false) {
  const root = await tempDir();
  git(root, 'init', '-q');
  await new LocalWorkspace(root).writeFile('app.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'first');
  if (dirty) await new LocalWorkspace(root).writeFile('notes.txt', 'draft');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

const output = () => {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
};

// Answers like GitHub's MCP server does.
const createPullRequest = defineTool({
  name: 'mcp__github__create_pull_request',
  description: 'Opens a pull request.',
  kind: 'network',
  parameters: z.object({ title: z.string() }),
  run: () => '{"html_url":"https://github.com/acme/app/pull/42","number":42}',
});

describe('linking sessions to what they produced', () => {
  it('saves the intent and starting commit, and links commits and pull requests', async () => {
    const { root, head } = await repo(true);
    const workspace = new LocalWorkspace(root);
    const responses: ScriptedResponse[] = [
      {
        toolCalls: [
          {
            name: 'run_command',
            args: { command: `git ${GIT.join(' ')} commit -qam "Fix the thing"` },
          },
        ],
      },
      { toolCalls: [{ name: 'mcp__github__create_pull_request', args: { title: 'Fix' } }] },
      { text: 'Opened https://github.com/acme/app/pull/42.' },
    ];
    await workspace.writeFile('app.txt', 'v2\n');
    const store = new JsonlSessionStore(root);
    const engine = await createEngine({
      model: new ScriptedModelClient(responses),
      workspace,
      toolsets: ['shell'],
      tools: [createPullRequest],
      permissions: { mode: 'bypass' },
      sessionStore: store,
      intent: 'build',
    });
    const session = engine.session();

    const events = await collect(session.send('Fix the thing and open a pull request'));
    await session.close();
    await engine.dispose();

    const links = events.filter((event) => event.type === 'link');
    expect(links.map(({ kind, ref, title }) => ({ kind, ref, title }))).toEqual([
      { kind: 'pull_request', ref: 'https://github.com/acme/app/pull/42', title: undefined },
      { kind: 'commit', ref: git(root, 'rev-parse', 'HEAD'), title: 'Fix the thing' },
    ]);
    expect(events.find((event) => event.type === 'run.start')).toMatchObject({ intent: 'build' });
    // Links come before the run ends, so traces attach them to the run.
    expect(events.at(-1)?.type).toBe('run.end');
    expect(String(engine.model.id)).toBeDefined();

    const [summary] = await store.list();
    expect(summary).toMatchObject({
      intent: 'build',
      runs: 1,
      pullRequests: ['https://github.com/acme/app/pull/42'],
      commits: [{ subject: 'Fix the thing' }],
      git: { head, dirty: true },
    });
    expect(formatSessions([summary!])).toContain('1 PR, 1 commit');
    const listed = output();
    await sessionsCommand({ json: true }, { cwd: root, stdout: listed });
    expect(JSON.parse(listed.text)).toHaveLength(1);
  });

  it('tells the model its session id, so it can cite it', async () => {
    const model = new ScriptedModelClient([{ text: 'Hi.' }]);
    const engine = await createEngine({ model, toolsets: [], git: false });
    const session = engine.session();
    await collect(session.send('Hi'));
    await engine.dispose();
    expect(model.requests[0]?.system).toContain(`heaw session: ${session.id}`);
  });
});

describe('heaw eval add', () => {
  it('turns a session into a case that starts from its commit', async () => {
    const { root, head } = await repo();
    const engine = await createEngine({
      model: new ScriptedModelClient([{ text: 'Done (badly).' }]),
      workspace: new LocalWorkspace(root),
      toolsets: ['fs'],
      sessionStore: new JsonlSessionStore(root),
    });
    const session = engine.session();
    await collect(session.send('Bump app.txt to v2'));
    await engine.dispose();
    // Later commits do not matter: the case starts where the session started.
    await new LocalWorkspace(root).writeFile('app.txt', 'v9\n');
    git(root, 'commit', '-qam', 'later');
    const stdout = output();

    const code = await evalAddCommand(
      'bump-version',
      { fromSession: session.id.slice(0, 15), check: ['grep -q v2 app.txt'] },
      { cwd: root, stdout, stderr: output() },
    );

    expect(code).toBe(0);
    expect(stdout.text).toContain(`starting at commit ${head.slice(0, 7)}`);
    const file = join(root, 'evals', 'bump-version.yaml');
    const evalCase = parseEvalCase(await readFile(file, 'utf8'), file);
    expect(evalCase).toMatchObject({
      checkout: head,
      prompt: 'Bump app.txt to v2',
      trials: 3,
      checks: [{ command: 'grep -q v2 app.txt', expectExitCode: 0 }],
    });

    // A trial gets the repository at that commit, with no remote to push to.
    const seen: string[] = [];
    const report = await runEvals([{ ...evalCase, trials: 1 }], {
      model: 'scripted:test',
      judge: new ScriptedModelClient([]),
      createWorkspace: (dir) => new LocalWorkspace(dir),
      createEngine: async (workspace) => {
        seen.push((await workspace.readFile('app.txt')).toString().trim());
        seen.push((await workspace.exec('git remote')).output.trim() || 'no remote');
        return createEngine({
          model: new ScriptedModelClient([
            { toolCalls: [{ name: 'read_file', args: { path: 'app.txt' } }] },
            { toolCalls: [{ name: 'write_file', args: { path: 'app.txt', content: 'v2\n' } }] },
            { text: 'Bumped.' },
          ]),
          workspace,
          toolsets: ['fs'],
          interactive: false,
          permissions: { mode: 'accept-edits' },
          git: false,
        });
      },
    });

    expect(seen).toEqual(['v1', 'no remote']);
    expect(report.passed).toBe(1);
  });

  it('refuses a session without a commit, and a case without checks does not load', async () => {
    const root = await tempDir();
    const engine = await createEngine({
      model: new ScriptedModelClient([{ text: 'Hi.' }]),
      workspace: new LocalWorkspace(root),
      toolsets: ['fs'],
      sessionStore: new JsonlSessionStore(root),
    });
    const session = engine.session();
    await collect(session.send('Hi'));
    await engine.dispose();
    const stderr = output();

    expect(
      await evalAddCommand(
        'x',
        { fromSession: session.id },
        { cwd: root, stdout: output(), stderr },
      ),
    ).toBe(2);
    expect(stderr.text).toContain('has no recorded commit');
    expect(() => parseEvalCase('prompt: Do it\ncheckout: abc123\nchecks:\n', 'x.yaml')).toThrow(
      'add at least one check',
    );
    expect(() =>
      parseEvalCase(
        'prompt: Do it\ncheckout: abc\nfixture: ./f\nchecks:\n  - answerContains: x',
        'x.yaml',
      ),
    ).toThrow('use fixture or checkout, not both');
  });
});

describe('comparing eval reports', () => {
  const report = (model: string, cases: Array<[string, boolean[], number]>): EvalReport => ({
    startedAt: '2026-11-02T13:00:00.000Z',
    model,
    cases: cases.map(([name, results, tokens]) => ({
      name,
      source: `${name}.yaml`,
      passed: results.filter(Boolean).length,
      trials: results.map((passed, index) => ({
        trial: index + 1,
        passed,
        stopReason: 'end_turn',
        checks: [],
        usage: {
          inputTokens: tokens,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: tokens / 1_000_000,
        turns: 3,
        durationMs: 1000,
        answer: '',
      })),
    })),
    passed: 0,
    total: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    judgeUsage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    durationMs: 1000,
  });

  it('shows each case before and after, and which got worse', async () => {
    const before = report('azure:a', [
      ['fix', [true, true, false], 40_000],
      ['add', [true, true, true], 30_000],
      ['old', [true], 1000],
    ]);
    const after = report('azure:b', [
      ['fix', [true, true, true], 20_000],
      ['add', [true, false, true], 30_000],
      ['new', [false], 1000],
    ]);

    const { cases, text } = compareReports(before, after);

    expect(cases).toEqual([
      { name: 'fix', change: 'better' },
      { name: 'add', change: 'worse' },
      { name: 'new', change: 'new' },
      { name: 'old', change: 'removed' },
    ]);
    expect(text).toContain('2/3 → 3/3');
    expect(text).toContain('40.0k → 20.0k');
    expect(text).toContain('Worse: add');
    // Also turns and time, which is what differs between a hosted and a local model.
    expect(text).toMatch(
      /case\s+passed\s+turns\/trial\s+tokens\/trial\s+cost\/trial\s+time\/trial\s+change\n/,
    );
    expect(text).toMatch(
      /fix\s+2\/3 → 3\/3\s+3 → 3\s+40\.0k → 20\.0k\s+\S+ → \S+\s+1s → 1s\s+better/,
    );
    expect(text).toContain('before: 0/0 passed · azure:a');
    expect(text).not.toContain('Judged by different models');
    expect(
      compareReports({ ...before, judgeModel: 'azure:a' }, { ...after, judgeModel: 'ollama:b' })
        .text,
    ).toContain('Judged by different models (azure:a, then ollama:b)');

    const dir = await tempDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'a.json'), JSON.stringify(before));
    await writeFile(join(dir, 'b.json'), JSON.stringify(after));
    const stdout = output();
    expect(
      await evalCompareCommand('a.json', 'b.json', { cwd: dir, stdout, stderr: output() }),
    ).toBe(1);
    expect(
      await evalCompareCommand('b.json', 'b.json', {
        cwd: dir,
        stdout: output(),
        stderr: output(),
      }),
    ).toBe(0);
  });
});

describe('where the tokens go', () => {
  it('counts model calls, what each tool adds to the context, and repeated calls', () => {
    const stats = new UsageStats();
    const base = { sessionId: 's', agentId: 'main', timestamp: 0 };
    const events: EngineEvent[] = [
      {
        ...base,
        type: 'usage',
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      { ...base, type: 'tool.start', callId: '1', tool: 'read_file', args: { path: 'a.ts' } },
      {
        ...base,
        type: 'tool.end',
        callId: '1',
        tool: 'read_file',
        output: 'x'.repeat(4000),
        status: 'ok',
        isError: false,
        durationMs: 1,
      },
      { ...base, type: 'tool.start', callId: '2', tool: 'read_file', args: { path: 'a.ts' } },
      {
        ...base,
        type: 'tool.end',
        callId: '2',
        tool: 'read_file',
        output: 'x'.repeat(4000),
        status: 'ok',
        isError: false,
        durationMs: 1,
      },
      { ...base, type: 'tool.start', callId: '3', tool: 'grep', args: { pattern: 'y' } },
      {
        ...base,
        type: 'tool.end',
        callId: '3',
        tool: 'grep',
        output: 'y',
        status: 'ok',
        isError: false,
        durationMs: 1,
      },
      {
        ...base,
        type: 'usage',
        usage: {
          inputTokens: 3500,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ];
    for (const event of events) stats.add(event);

    expect(stats.breakdown()).toEqual({
      tools: [
        { tool: 'read_file', calls: 2, resultTokens: 2000, repeated: 1 },
        { tool: 'grep', calls: 1, resultTokens: 1, repeated: 0 },
      ],
      modelCalls: 2,
      largestRequest: 3500,
    });
    const text = describeBreakdown(stats.breakdown()).join('\n');
    expect(text).toContain('Model calls: 2');
    expect(text).toContain('read_file ~2.0k (2 calls, 1 repeated)');
    expect(text).toContain('1 call was made before with the same arguments');
  });
});
