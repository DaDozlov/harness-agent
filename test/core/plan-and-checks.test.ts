import { describe, expect, it } from 'vitest';
import {
  BUILD_PROMPT,
  type CommandContext,
  planPrompt,
  runSlashCommand,
} from '../../src/cli/chat/commands.js';
import { failureKey, MAX_SAME_CHECK_FAILURES } from '../../src/core/loop.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { BUILT_IN_SKILLS } from '../../src/skills/built-in.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

async function engineWith(responses: ScriptedResponse[], options: Partial<EngineOptions> = {}) {
  const workspace = await tempWorkspace();
  const model = new ScriptedModelClient(responses);
  const engine = await createEngine({ model, workspace, toolsets: ['fs'], git: false, ...options });
  return { engine, model, workspace };
}

describe('a check that keeps failing the same way', () => {
  it('ends the run after three identical failures instead of looping to the turn limit', async () => {
    const answers = Array.from({ length: 10 }, () => ({ text: 'Done, I think.' }));
    const { engine, model } = await engineWith(answers, {
      hooks: {
        beforeStop: () => ({
          continue: true,
          feedback: `/usr/bin/bash: mvn: command not found\nTotal time: ${Math.random()} s`,
        }),
      },
    });

    const events = await collect(engine.session().send('Build it'));
    await engine.dispose();

    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'check_failed' });
    expect(model.requests).toHaveLength(MAX_SAME_CHECK_FAILURES);
  });

  it('keeps going while the failure changes, e.g. fewer tests failing', async () => {
    let failing = 3;
    const { engine } = await engineWith(
      Array.from({ length: 5 }, () => ({ text: 'Fixed one more.' })),
      {
        hooks: {
          beforeStop: () =>
            failing ? { continue: true, feedback: `${failing--} tests failed` } : undefined,
        },
      },
    );

    const events = await collect(engine.session().send('Fix the tests'));
    await engine.dispose();

    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'end_turn' });
  });

  it('ignores timings and timestamps, not counts', () => {
    const maven = (time: string, at: string, failures: number) =>
      `[INFO] Total time:  ${time} s\n[INFO] Finished at: ${at}\nTests run: 5, Failures: ${failures}`;

    expect(failureKey(maven('3.456', '2026-11-04T10:20:30+01:00', 1))).toBe(
      failureKey(maven('4.1', '2026-11-04T10:21:02+01:00', 1)),
    );
    expect(failureKey('Duration 1.23s (transform 120ms)')).toBe(
      failureKey('Duration 2.5s (transform 98ms)'),
    );
    expect(failureKey('3 failed')).not.toBe(failureKey('2 failed'));
  });
});

describe('reasoning effort', () => {
  it('goes with every model call, and a session can raise it', async () => {
    const { engine, model } = await engineWith([{ text: 'a' }, { text: 'b' }], {
      reasoningEffort: 'low',
    });
    const session = engine.session();

    await collect(session.send('one'));
    session.setReasoningEffort('high');
    await collect(session.send('two'));
    await engine.dispose();

    expect(model.requests.map((request) => request.reasoningEffort)).toEqual(['low', 'high']);
  });
});

describe('/plan', () => {
  it('plans read-only with only PLAN.md writable and more thinking, then builds in the old mode', async () => {
    const { engine, workspace } = await engineWith([], { permissions: { mode: 'accept-edits' } });
    const session = engine.session();
    const sent: string[] = [];
    const printed: string[] = [];
    const context = {
      engine,
      session: () => session,
      send: (text: string) => sent.push(text),
      print: (text: string) => printed.push(text),
      refresh: () => undefined,
    } as unknown as CommandContext;
    const write = { name: 'write_file', kind: 'write' as const };

    await runSlashCommand('/plan Compare XML invoices at scale', context);

    expect(session.inPlanMode).toBe(true);
    expect(session.permissions.mode).toBe('read-only');
    expect(session.reasoningEffort).toBe('high');
    expect(session.permissions.check(write, { value: 'PLAN.md', type: 'path' }).decision).toBe(
      'allow',
    );
    expect(session.permissions.check(write, { value: 'src/a.ts', type: 'path' }).decision).toBe(
      'deny',
    );
    expect(sent).toEqual([planPrompt('Compare XML invoices at scale')]);

    await runSlashCommand('/plan go', context);
    expect(printed.at(-1)).toContain('There is no PLAN.md yet');
    expect(session.inPlanMode).toBe(true);

    await workspace.writeFile('PLAN.md', '# Plan\n- [ ] 1. Skeleton');
    await runSlashCommand('/plan go', context);
    await engine.dispose();

    expect(session.inPlanMode).toBe(false);
    expect(session.permissions.mode).toBe('accept-edits');
    expect(session.reasoningEffort).toBeUndefined();
    expect(sent.at(-1)).toBe(BUILD_PROMPT);
  });
});

describe('the agent deciding to plan', () => {
  const call = (name: string, args: unknown): ScriptedResponse => ({ toolCalls: [{ name, args }] });
  const plan = [
    call('start_plan', { reason: 'A pipeline with design choices.' }),
    call('write_file', { path: 'src/main.ts', content: 'too early' }),
    call('write_file', { path: 'PLAN.md', content: '# Plan\n- [ ] 1. Skeleton' }),
    call('finish_plan', { summary: 'Streaming pipeline, 6 steps, risk: speed.' }),
  ];

  it('plans read-only after start_plan, and builds once the user approves the plan', async () => {
    const { engine, model, workspace } = await engineWith(
      [
        ...plan,
        call('write_file', { path: 'src/main.ts', content: 'step 1' }),
        { text: 'Step 1 done.' },
      ],
      { toolsets: ['fs', 'plan'], permissions: { mode: 'accept-edits' }, verifyChanges: false },
    );
    const session = engine.session();
    const approvals: string[] = [];

    for await (const event of session.send('Build a reconciliation service')) {
      if (event.type === 'approval.request') {
        approvals.push(event.tool);
        expect(session.inPlanMode).toBe(true);
        session.approve(event.requestId, { allow: true, scope: 'once' });
      }
    }
    await engine.dispose();

    expect(model.requests[0]?.system).toContain('call start_plan and plan it properly');
    expect(model.requests[1]?.reasoningEffort).toBe('high');
    // In plan mode, only PLAN.md could be written.
    expect(JSON.stringify(model.requests[2]?.messages.at(-1))).toContain('Permission denied');
    expect(approvals).toEqual(['finish_plan']);
    expect(session.inPlanMode).toBe(false);
    expect(session.permissions.mode).toBe('accept-edits');
    expect(JSON.stringify(model.requests[4]?.messages.at(-1))).toContain(
      'The user approved PLAN.md',
    );
    expect((await workspace.readFile('src/main.ts')).toString()).toBe('step 1');
  });

  it('stays in plan mode when nobody can approve the plan', async () => {
    const { engine } = await engineWith([...plan, { text: 'The plan is in PLAN.md.' }], {
      toolsets: ['fs', 'plan'],
      interactive: false,
    });
    const session = engine.session();

    await collect(session.send('Build a reconciliation service'));
    await engine.dispose();

    expect(session.inPlanMode).toBe(true);
  });

  it('comes with a built-in skill, and the base prompt asks for small verified steps', async () => {
    const { engine, model } = await engineWith([{ text: 'ok' }]);
    await collect(engine.session().send('hi'));
    await engine.dispose();

    expect(BUILT_IN_SKILLS.map((skill) => skill.name)).toEqual([
      'setup-harness',
      'plan-work',
      'retro',
    ]);
    expect(BUILT_IN_SKILLS[1]?.content).toContain('finish_plan');
    const system = model.requests[0]?.system ?? '';
    // No plan tools in this engine, so planning happens in the conversation.
    expect(system).toContain('Plan before building anything bigger than a few files');
    expect(system).toContain('Build in small steps');
    expect(system).toContain('do not fake or work around it');
    // Always, not only with a plan: changes together, and what to check in a user interface.
    expect(system).toContain('Make independent changes together');
    expect(system).toContain('Tests do not see layout.');
  });
});
