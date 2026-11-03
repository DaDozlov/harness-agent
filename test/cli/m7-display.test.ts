import { describe, expect, it } from 'vitest';
import { runSlashCommand } from '../../src/cli/chat/commands.js';
import { createTranscript, transcriptReducer } from '../../src/cli/chat/transcript.js';
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

    expect(state.items).toMatchObject([
      { kind: 'tool', label: 'delegate reviewer: Review app.ts', status: 'ok' },
      { kind: 'tool', label: 'read_file app.ts', status: 'ok', agent: 'reviewer' },
    ]);
    expect(state.items).toHaveLength(2);
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
