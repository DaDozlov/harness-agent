import { describe, expect, it } from 'vitest';
import { runSlashCommand } from '../../src/cli/chat/commands.js';
import {
  createTranscript,
  hookAgentRunning,
  transcriptReducer,
} from '../../src/cli/chat/transcript.js';
import { runPrompt } from '../../src/cli/commands/run.js';
import type { EngineEventBody } from '../../src/core/events.js';
import { emptyUsage } from '../../src/core/usage.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const reviewer = {
  name: 'reviewer',
  description: 'Reviews code for bugs.',
  prompt: 'You review code.',
  tools: ['read_file'],
  source: 'test',
};

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

describe('sub-agents in the chat', () => {
  it("shows a sub-agent's tool calls under its name, and not its streaming text", () => {
    const main = { sessionId: 's', agentId: 'main', timestamp: 0 };
    const child = { sessionId: 's', agentId: 'reviewer-1', parentAgentId: 'main', timestamp: 0 };
    const events: Array<EngineEventBody & { agentId: string }> = [
      {
        ...main,
        type: 'tool.start',
        callId: 'call_1',
        tool: 'delegate',
        args: { agent: 'reviewer', task: 'Review app.ts' },
      },
      {
        ...main,
        type: 'subagent.start',
        childAgentId: 'reviewer-1',
        name: 'reviewer',
        task: 'Review app.ts',
        callId: 'call_1',
      },
      // The same call id as the parent's: told apart by agent.
      {
        ...child,
        type: 'tool.start',
        callId: 'call_1',
        tool: 'read_file',
        args: { path: 'app.ts' },
      },
      { ...child, type: 'text.delta', text: 'thinking out loud' },
      {
        ...child,
        type: 'tool.end',
        callId: 'call_1',
        tool: 'read_file',
        output: 'x',
        status: 'ok',
        isError: false,
        durationMs: 1,
      },
      { ...child, type: 'run.end', stopReason: 'max_turns', usage: emptyUsage(), turns: 1 },
      {
        ...main,
        type: 'tool.end',
        callId: 'call_1',
        tool: 'delegate',
        output: 'report',
        status: 'ok',
        isError: false,
        durationMs: 2,
      },
    ];
    let state = createTranscript(emptyUsage());
    for (const event of events)
      state = transcriptReducer(state, { type: 'event', event: event as never });

    // Where its calls begin, its calls, then the delegate call when it is done.
    expect(state.items).toMatchObject([
      { kind: 'agent', label: 'reviewer', task: 'Review app.ts' },
      { kind: 'tool', label: 'read_file app.ts', status: 'ok', agent: 'reviewer' },
      { kind: 'tool', label: 'delegate reviewer: Review app.ts', status: 'ok' },
    ]);
    expect(state.items).toHaveLength(3);
    expect(state.committed).toBe(3);
  });

  it('keeps the live area to the running delegate calls while parallel sub-agents work', () => {
    const main = { sessionId: 's', agentId: 'main', timestamp: 0 };
    const child = (n: number) => ({
      sessionId: 's',
      agentId: `ui-builder-${n}`,
      parentAgentId: 'main',
      timestamp: 0,
    });
    const delegate = (n: number, task: string): EngineEventBody & { agentId: string } => ({
      ...main,
      type: 'tool.start',
      callId: `call_${n}`,
      tool: 'delegate',
      args: { agent: 'ui-builder', task },
    });
    const events: Array<EngineEventBody & { agentId: string }> = [
      delegate(1, 'Companies page'),
      delegate(2, 'Contacts page'),
      ...[1, 2].map((n) => ({
        ...main,
        type: 'subagent.start' as const,
        childAgentId: `ui-builder-${n}`,
        name: 'ui-builder',
        task: n === 1 ? 'Companies page' : 'Contacts page',
        callId: `call_${n}`,
      })),
    ];
    // 40 calls between them, each finished before the next starts.
    for (let index = 0; index < 40; index++) {
      const n = (index % 2) + 1;
      const call = { callId: `c${index}`, tool: 'read_file' };
      events.push(
        { ...child(n), type: 'tool.start', ...call, args: { path: `f${index}.ts` } },
        {
          ...child(n),
          type: 'tool.end',
          ...call,
          output: 'x',
          status: 'ok',
          isError: false,
          durationMs: 1,
        },
      );
    }
    let state = createTranscript(emptyUsage());
    for (const event of events)
      state = transcriptReducer(state, { type: 'event', event: event as never });

    // Everything finished is printed for good; only the two delegate calls are redrawn.
    const live = state.items.slice(state.committed);
    expect(live).toMatchObject([
      {
        label: 'delegate ui-builder: Companies page',
        status: 'running',
        progress: { agent: 'ui-builder 1', calls: 20, last: 'read_file f38.ts' },
      },
      {
        label: 'delegate ui-builder: Contacts page',
        status: 'running',
        progress: { agent: 'ui-builder 2', calls: 20, last: 'read_file f39.ts' },
      },
    ]);
    // Both are numbered from their first line on, each in its own color.
    const done = state.items.slice(0, state.committed);
    const headers = done.filter((item) => item.kind === 'agent');
    expect(headers).toMatchObject([
      { label: 'ui-builder 1', task: 'Companies page' },
      { label: 'ui-builder 2', task: 'Contacts page' },
    ]);
    expect(new Set(headers.map((item) => item.color)).size).toBe(2);
    const calls = done.filter((item) => item.kind === 'tool');
    expect(calls).toHaveLength(40);
    expect(calls.slice(0, 2)).toMatchObject([
      { agent: 'ui-builder 1', agentColor: headers[0]?.color, label: 'read_file f0.ts' },
      { agent: 'ui-builder 2', agentColor: headers[1]?.color, label: 'read_file f1.ts' },
    ]);

    // Once both are done, a sub-agent of that name is plain "ui-builder" again.
    for (const n of [1, 2]) {
      state = transcriptReducer(state, {
        type: 'event',
        event: {
          ...main,
          type: 'subagent.end',
          childAgentId: `ui-builder-${n}`,
          name: 'ui-builder',
          stopReason: 'end_turn',
          turns: 20,
          usage: emptyUsage(),
        } as never,
      });
    }
    state = transcriptReducer(state, {
      type: 'event',
      event: {
        ...main,
        type: 'subagent.start',
        childAgentId: 'ui-builder-3',
        name: 'ui-builder',
        task: 'Deals page',
      } as never,
    });
    expect(state.items.at(-1)).toMatchObject({ kind: 'agent', label: 'ui-builder' });
  });

  it("names a hook's agent while it works, until it ends or the run does", () => {
    const main = { sessionId: 's', agentId: 'main', timestamp: 0 };
    const start = (n: number) =>
      ({
        ...main,
        type: 'subagent.start',
        childAgentId: `ui-tester-hook-${n}`,
        name: 'ui-tester',
        task: 'Changed: app/page.tsx.',
      }) as never;
    let state = createTranscript(emptyUsage());
    state = transcriptReducer(state, { type: 'event', event: start(1) });
    expect(hookAgentRunning(state)).toMatchObject({ label: 'ui-tester' });

    state = transcriptReducer(state, {
      type: 'event',
      event: {
        ...main,
        type: 'subagent.end',
        childAgentId: 'ui-tester-hook-1',
        name: 'ui-tester',
        stopReason: 'end_turn',
        turns: 9,
        usage: emptyUsage(),
        summary: 'Verdict: works',
      } as never,
    });
    expect(hookAgentRunning(state)).toBeUndefined();
    expect(state.items.at(-1)).toMatchObject({ kind: 'notice', text: 'ui-tester: Verdict: works' });

    // Interrupted before its end arrived: the run's end stops it all the same.
    state = transcriptReducer(state, { type: 'event', event: start(2) });
    state = transcriptReducer(state, {
      type: 'event',
      event: { ...main, type: 'run.end', stopReason: 'aborted', usage: emptyUsage(), turns: 3 },
    });
    expect(hookAgentRunning(state)).toBeUndefined();
  });

  it('/agents and /skills list what the agent can use', async () => {
    const engine = await createEngine({
      model: new ScriptedModelClient([]),
      workspace: await tempWorkspace(),
      agents: [reviewer],
      git: false,
    });
    const printed: string[] = [];
    const ctx = {
      engine,
      session: () => engine.session(),
      print: (text: string) => printed.push(text),
      newSession: () => undefined,
      refresh: () => undefined,
      exit: () => undefined,
    };

    await runSlashCommand('/agents', ctx);
    await runSlashCommand('/skills', ctx);
    await engine.dispose();

    expect(printed).toEqual([
      'reviewer (tools: read_file): Reviews code for bugs.',
      'No skills. Add one as .heaw/skills/<name>/SKILL.md (front matter: name, description).',
    ]);
  });
});

describe('sub-agents in heaw run', () => {
  it("prints the sub-agent's activity with its name, and only the main answer to stdout", async () => {
    const workspace = await tempWorkspace();
    await workspace.writeFile('app.ts', 'export const x = 1;\n');
    const engine = await createEngine({
      model: new ScriptedModelClient([
        { toolCalls: [{ name: 'delegate', args: { agent: 'reviewer', task: 'Review app.ts' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'app.ts' } }] },
        { text: 'No bugs found.' },
        { text: 'All good.' },
      ]),
      workspace,
      toolsets: ['fs', 'agents'],
      agents: [reviewer],
      interactive: false,
      git: false,
    });
    const stdout = output();
    const stderr = output();

    const code = await runPrompt(engine, 'Review', {}, { stdout, stderr });
    await engine.dispose();

    expect(code).toBe(0);
    expect(stdout.text).toBe('All good.\n');
    expect(stderr.text).toContain(
      [
        '[agent] reviewer: Review app.ts',
        '  [reviewer] [tool] read_file app.ts',
        '[agent] reviewer finished · 2 turns',
        '[tool] delegate reviewer: Review app.ts',
      ].join('\n'),
    );
  });
});
