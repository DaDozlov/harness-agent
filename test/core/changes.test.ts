import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../src/agents/definitions.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

const reviewer: AgentDefinition = {
  name: 'reviewer',
  description: 'Reviews changes.',
  prompt: 'You review changes.',
  tools: ['read_file'],
  mode: 'read-only',
  source: 'test',
};

async function engineWith(responses: ScriptedResponse[], options: Partial<EngineOptions> = {}) {
  const model = new ScriptedModelClient(responses);
  const workspace = await tempWorkspace();
  await workspace.writeFile('app.ts', 'export const answer = 41;\n');
  const engine = await createEngine({
    model,
    workspace,
    toolsets: ['fs', 'agents'],
    permissions: { mode: 'accept-edits' },
    git: false,
    agents: [reviewer],
    ...options,
  });
  return { model, engine, workspace };
}

const call = (name: string, args: unknown): ScriptedResponse => ({ toolCalls: [{ name, args }] });
const read = (path: string) => call('read_file', { path });
const write = (path: string, content: string) => call('write_file', { path, content });

describe('file changes and rewind', () => {
  it('tells beforeStop which files the run edited, and rewinds them', async () => {
    const edited: string[][] = [];
    const { model, engine, workspace } = await engineWith(
      [
        read('app.ts'),
        write('app.ts', 'export const answer = 42;\n'),
        write('notes/new.md', 'new'),
        { text: 'Done.' },
        { text: 'Nothing to change.' },
        { text: 'Ok.' },
      ],
      { hooks: { beforeStop: ({ editedFiles }) => void edited.push(editedFiles) } },
    );
    const session = engine.session();

    await collect(session.send('Fix the answer'));
    await collect(session.send('Anything else?'));

    expect(edited).toEqual([['app.ts', 'notes/new.md'], []]);
    expect(session.fileChanges()).toEqual([
      { input: 'Fix the answer', files: ['app.ts', 'notes/new.md'] },
    ]);

    const report = await session.rewind();

    expect(report).toEqual({
      runs: [{ input: 'Fix the answer', files: ['app.ts', 'notes/new.md'] }],
      restored: ['app.ts', 'notes/new.md'],
      skipped: [],
    });
    expect((await workspace.readFile('app.ts')).toString()).toBe('export const answer = 41;\n');
    expect(await workspace.stat('notes/new.md')).toBeUndefined();
    expect(session.fileChanges()).toEqual([]);

    // The model learns about it with the next input.
    await collect(session.send('Try again later'));
    const lastUser = model.requests.at(-1)?.messages.at(-1);
    expect(JSON.stringify(lastUser)).toContain(
      'The user undid your file changes from the last run',
    );
    expect(JSON.stringify(lastUser)).toContain('Try again later');
    await engine.dispose();
  });

  it("counts a sub-agent's changes as its parent's run", async () => {
    const helper: AgentDefinition = {
      ...reviewer,
      name: 'helper',
      tools: ['write_file'],
      mode: undefined,
    };
    const { engine, workspace } = await engineWith(
      [
        call('delegate', { agent: 'helper', task: 'Write a.txt' }),
        write('a.txt', 'from the sub-agent'),
        { text: 'Wrote a.txt.' },
        { text: 'The helper wrote it.' },
      ],
      { agents: [helper] },
    );
    const session = engine.session();

    await collect(session.send('Have the helper write a.txt'));

    expect(session.fileChanges()).toEqual([
      { input: 'Have the helper write a.txt', files: ['a.txt'] },
    ]);
    await session.rewind();
    expect(await workspace.stat('a.txt')).toBeUndefined();
    await engine.dispose();
  });

  it('rewinds several runs back to before the earliest of them', async () => {
    const { engine, workspace } = await engineWith([
      read('app.ts'),
      write('app.ts', 'v2'),
      { text: 'v2' },
      read('app.ts'),
      write('app.ts', 'v3'),
      { text: 'v3' },
    ]);
    const session = engine.session();
    await collect(session.send('one'));
    await collect(session.send('two'));

    const report = await session.rewind(5);

    expect(report.runs.map((run) => run.input)).toEqual(['two', 'one']);
    expect((await workspace.readFile('app.ts')).toString()).toBe('export const answer = 41;\n');
    await engine.dispose();
  });
});

describe('runAgent in hooks', () => {
  it('lets beforeStop ask a reviewer, which cannot start agents itself', async () => {
    const seen: Array<boolean> = [];
    let reviews = 0;
    const { model, engine } = await engineWith(
      [
        { text: 'All done.' },
        // The reviewer's run.
        { text: 'Looks wrong: answer should be 42.' },
        { text: 'Fixed per the review.' },
      ],
      {
        hooks: {
          async beforeStop({ runAgent, agentId }) {
            seen.push(runAgent !== undefined);
            if (agentId !== 'main' || reviews++ > 0 || !runAgent) return undefined;
            const review = await runAgent('reviewer', 'Review the change');
            return { continue: true, feedback: review.text };
          },
          // Tool hooks run in the reviewer too; conversation hooks do not.
          sessionStart: ({ runAgent }) => void seen.push(runAgent !== undefined),
        },
      },
    );

    const events = await collect(engine.session().send('Change the answer'));
    await engine.dispose();

    expect(seen).toEqual([true, true, true]);
    // The user sees that the reviewer ran, and its last line.
    expect(events.filter((event) => event.type.startsWith('subagent.'))).toMatchObject([
      { type: 'subagent.start', name: 'reviewer', task: 'Review the change' },
      {
        type: 'subagent.end',
        name: 'reviewer',
        stopReason: 'end_turn',
        turns: 1,
        summary: 'Looks wrong: answer should be 42.',
      },
    ]);
    expect(model.requests[1]?.system).toContain('You review changes.');
    expect(JSON.stringify(model.requests[2]?.messages.at(-1))).toContain(
      'Looks wrong: answer should be 42.',
    );
  });
});
