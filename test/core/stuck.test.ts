import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeNearLimit, describeStuck } from '../../src/cli/format.js';
import type { EngineEvent } from '../../src/core/events.js';
import { nearLimit, nearLimitNote } from '../../src/core/loop.js';
import { isHeawNote, textOf } from '../../src/core/messages.js';
import type { ModelCapabilities, ModelRequest } from '../../src/core/model.js';
import { Session, type SessionOptions } from '../../src/core/session.js';
import { LoopDetector } from '../../src/core/stuck.js';
import { emptyUsage } from '../../src/core/usage.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { defineTool } from '../../src/tools/define.js';
import { FS_TOOLS } from '../../src/tools/fs.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

/** A check that fails with the output it is given, like a test run. */
const check = defineTool({
  name: 'check',
  description: 'Run the checks',
  kind: 'read',
  parameters: z.object({ output: z.string() }),
  run: ({ output }) => ({ output, isError: true }),
});

async function setup(
  responses: ScriptedResponse[],
  options: Partial<SessionOptions> & { capabilities?: Partial<ModelCapabilities> } = {},
) {
  const { capabilities, ...rest } = options;
  const model = new ScriptedModelClient(responses, { ...(capabilities && { capabilities }) });
  const workspace = await tempWorkspace();
  const session = new Session({
    model,
    system: 'Be brief.',
    workspace,
    tools: [check, ...FS_TOOLS],
    permissions: { mode: 'accept-edits' },
    interactive: false,
    ...rest,
  });
  return { model, session, workspace };
}

const call = (name: string, args: unknown): ScriptedResponse => ({ toolCalls: [{ name, args }] });
/** heaw's note after the last tool results, if the request ends with one. */
const lastNote = (request: ModelRequest | undefined) => {
  const message = request?.messages.at(-1);
  return message && isHeawNote(message) ? textOf(message) : '';
};
/** The outputs of the last tool results, which carry no notes of heaw's. */
const lastOutputs = (request: ModelRequest | undefined) => {
  const message = request?.messages.findLast((candidate) => candidate.role === 'tool');
  return message?.role === 'tool' ? message.content.map((part) => part.output).join('\n') : '';
};
const stuckEvents = (events: EngineEvent[]) =>
  events.filter(
    (event): event is Extract<EngineEvent, { type: 'stuck' }> => event.type === 'stuck',
  );

describe('going in circles', () => {
  it('notices a call failing the same way three times, once, and thinks harder after', async () => {
    const failing = (time: string) => call('check', { output: `FAIL total 3, took ${time}` });
    const { model, session } = await setup(
      [
        failing('1.2s'),
        failing('0.9s'),
        failing('1.4s'), // timings differ, the failure is the same
        failing('1.1s'), // told once is enough
        { text: 'I could not fix it.' },
      ],
      { capabilities: { reasoning: true } },
    );

    const events = await collect(session.send('Fix the tests'));

    expect(lastNote(model.requests[2])).toBe('');
    // In a message of its own: what tools return is data, and a note inside it read as such.
    expect(lastNote(model.requests[3])).toContain(
      '[heaw: this failed the same way 3 times now (check). Small variations of the same fix rarely help.',
    );
    expect(lastOutputs(model.requests[3])).not.toContain('heaw:');
    expect(lastNote(model.requests[4])).toBe('');
    expect(stuckEvents(events)).toEqual([
      expect.objectContaining({ signal: 'same-failure', subject: 'check', count: 3 }),
    ]);
    // The call after the note thinks harder; the others as configured.
    expect(model.requests.map((request) => request.reasoningEffort)).toEqual([
      undefined,
      undefined,
      undefined,
      'high',
      undefined,
    ]);
  });

  it('counts progress as progress: a different failure starts over', async () => {
    const { model, session } = await setup([
      call('check', { output: '5 tests failed' }),
      call('check', { output: '4 tests failed' }),
      call('check', { output: '3 tests failed' }),
      { text: 'Getting there.' },
    ]);

    const events = await collect(session.send('Fix the tests'));

    expect(stuckEvents(events)).toEqual([]);
    expect(lastNote(model.requests[3])).toBe('');
  });

  it('notices a file going back and forth between the same contents', async () => {
    const edit = (from: string, to: string) =>
      call('edit_file', { path: 'a.ts', old_string: from, new_string: to });
    const { model, session, workspace } = await setup([
      call('read_file', { path: 'a.ts' }),
      edit('= 1', '= 2'),
      edit('= 2', '= 1'), // back to the start: one step back can be right
      edit('= 1', '= 2'), // and forth again: going in circles
      { text: 'Done.' },
    ]);
    await workspace.writeFile('a.ts', 'export const a = 1;\n');

    const events = await collect(session.send('Fix a'));

    expect(lastNote(model.requests[3])).toBe('');
    expect(lastNote(model.requests[4])).toContain(
      'heaw: a.ts is back to content it had earlier in this task, for the second time: your changes go back and forth.',
    );
    expect(stuckEvents(events)).toEqual([
      expect.objectContaining({ signal: 'back-and-forth', subject: 'a.ts', count: 2 }),
    ]);
  });

  it('starts over with each run', async () => {
    const workspace = await tempWorkspace();
    const detector = new LoopDetector(workspace);
    const failure = {
      tool: 'run_command',
      args: { command: 'npm test' },
      output: 'x',
      status: 'error' as const,
    };
    detector.finished(failure);
    detector.finished(failure);
    detector.reset();
    expect(detector.finished(failure)).toBeUndefined();
    expect(detector.finished(failure)).toBeUndefined();
    expect(detector.finished(failure)).toEqual({
      signal: 'same-failure',
      subject: 'npm test',
      count: 3,
    });
    expect(describeStuck({ signal: 'same-failure', subject: 'npm test', count: 3 })).toBe(
      'npm test failed the same way 3 times, so the agent was asked to step back and try a different approach.',
    );
  });
});

describe('thinking harder', () => {
  it('after a check before finishing failed, for one call, on models that reason', async () => {
    let checked = false;
    const hooks = {
      beforeStop: () => {
        if (checked) return undefined;
        checked = true;
        return { continue: true, feedback: '1 test failed' };
      },
    };
    const responses = [{ text: 'Done.' }, { text: 'Fixed.' }];
    const reasoning = await setup(responses, { hooks, capabilities: { reasoning: true } });
    await collect(reasoning.session.send('Fix it'));
    expect(reasoning.model.requests.map((request) => request.reasoningEffort)).toEqual([
      undefined,
      'high',
    ]);

    checked = false;
    const plain = await setup(responses, { hooks });
    await collect(plain.session.send('Fix it'));
    expect(plain.model.requests.map((request) => request.reasoningEffort)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe('near the time limit', () => {
  it('counts minutes like the other limits', () => {
    const spent = { turns: 3, usage: emptyUsage(), costUsd: undefined, minutes: 41.5 };
    const near = nearLimit({ maxTurns: 100, maxMinutes: 50 }, spent);
    expect(near).toEqual({ limit: 'time', used: 41.5, max: 50 });
    expect(nearLimitNote(near!)).toContain(
      'heaw: this message has used 83% of its time limit (41 of 50 minutes). Finish what you are doing',
    );
    expect(describeNearLimit(near!)).toBe(
      'This message has used 83% of its time limit (41 of 50 minutes), so the agent was asked to finish what it is doing and report what is left.',
    );
    expect(nearLimit({ maxTurns: 100, maxMinutes: 50 }, { ...spent, minutes: 30 })).toBeUndefined();
  });
});
