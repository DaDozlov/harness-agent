import { describe, expect, it } from 'vitest';
import { type CommandContext, runSlashCommand } from '../../src/cli/chat/commands.js';
import type { EngineEvent } from '../../src/core/events.js';
import { archivePlan, droppedSteps, planSteps } from '../../src/core/plan.js';
import type { Session } from '../../src/core/session.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

const call = (name: string, args: unknown): ScriptedResponse => ({ toolCalls: [{ name, args }] });
const PLAN =
  '# Plan: Compare invoices\n\n## Steps\n- [ ] 1. Skeleton\n- [ ] 2. Core\n- [ ] 3. Report\n';
const tick = (step: number) =>
  call('edit_file', {
    path: 'PLAN.md',
    old_string: `- [ ] ${step}.`,
    new_string: `- [x] ${step}.`,
  });

async function engineWith(responses: ScriptedResponse[], options: Partial<EngineOptions> = {}) {
  const workspace = await tempWorkspace();
  const model = new ScriptedModelClient(responses);
  const engine = await createEngine({
    model,
    workspace,
    toolsets: ['fs', 'plan'],
    permissions: { mode: 'accept-edits' },
    git: false,
    ...options,
  });
  return { engine, model, workspace };
}

/** Sends, approving whatever is asked. */
async function run(session: Session, input: string): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of session.send(input)) {
    events.push(event);
    if (event.type === 'approval.request') {
      session.approve(event.requestId, { allow: true, scope: 'once' });
    }
  }
  return events;
}

const nudges = (events: EngineEvent[]) =>
  events.filter((event) => event.type === 'hook' && event.builtIn);

describe('plan steps', () => {
  it('are the checkboxes of PLAN.md', () => {
    expect(planSteps(PLAN.replace('- [ ] 1.', '- [x] 1.'))).toEqual({
      done: 1,
      open: ['2. Core', '3. Report'],
      all: ['1. Skeleton', '2. Core', '3. Report'],
    });
    expect(planSteps('# Plan\nNo steps.')).toEqual({ done: 0, open: [], all: [] });
  });

  it('dropped: approved steps no longer there, as written or with something added', () => {
    const approved = ['1. Skeleton', '2. Core with `parse()`', '3. Report'];
    expect(
      droppedSteps(approved, [
        '1. Skeleton (done, 4 tests)',
        '~~2. Core with parse()~~',
        '3. Report',
      ]),
    ).toEqual([]);
    expect(droppedSteps(approved, ['1. Skeleton', '2. Core, simplified'])).toEqual([
      '2. Core with `parse()`',
      '3. Report',
    ]);
  });

  it('move to .heaw/plans when a new plan starts, so earlier ones are kept', async () => {
    const workspace = await tempWorkspace();
    const day = new Date('2026-11-04T12:00:00Z');
    expect(await archivePlan(workspace, day)).toBeUndefined();

    await workspace.writeFile('PLAN.md', PLAN);
    expect(await archivePlan(workspace, day)).toBe('.heaw/plans/2026-11-04-compare-invoices.md');
    await workspace.writeFile('PLAN.md', PLAN);
    expect(await archivePlan(workspace, day)).toBe('.heaw/plans/2026-11-04-compare-invoices-2.md');

    expect(await workspace.stat('PLAN.md')).toBeUndefined();
    const kept = await workspace.readFile('.heaw/plans/2026-11-04-compare-invoices.md');
    expect(kept.toString()).toBe(PLAN);
  });

  it('start_plan moves the previous plan away and says where', async () => {
    const { engine, model, workspace } = await engineWith([
      call('start_plan', { reason: 'Big task.' }),
      { text: 'Planning.' },
    ]);
    await workspace.writeFile('PLAN.md', PLAN);

    await run(engine.session(), 'Plan the next feature');
    await engine.dispose();

    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).toContain(
      'The previous plan was moved to .heaw/plans/',
    );
    expect(await workspace.stat('PLAN.md')).toBeUndefined();
  });
});

describe('building an approved plan', () => {
  const approved = [
    call('start_plan', { reason: 'Big task.' }),
    call('write_file', { path: 'PLAN.md', content: PLAN }),
    call('finish_plan', { summary: 'Three steps.' }),
  ];

  it('sends the agent back when it stops between steps, once per step', async () => {
    const { engine, model } = await engineWith([
      ...approved,
      { text: 'The plan is approved. Say go and I start.' },
      call('write_file', { path: 'src/a.ts', content: 'a' }),
      tick(1),
      { text: 'Step 1 is done. Now on to step 2.' },
      tick(2),
      { text: 'I need your API key for step 3.' },
      { text: 'Step 3 needs your API key; I cannot go on without it.' },
    ]);
    const session = engine.session();

    const events = await run(session, 'Build the comparator');
    await engine.dispose();

    expect(nudges(events)).toHaveLength(3);
    expect(JSON.stringify(model.requests[4]?.messages.at(-1))).toContain(
      'PLAN.md still has 3 open steps; the next is: 1. Skeleton',
    );
    expect(JSON.stringify(model.requests[7]?.messages.at(-1))).toContain('the next is: 2. Core');
    // Stopping again without progress means it is waiting for the user on purpose.
    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'end_turn' });
    expect(model.requests).toHaveLength(10);
    expect(session.buildingPlan).toBe(true);
  });

  it('tells the agent once when a change drops a step the user approved', async () => {
    const { engine, model } = await engineWith([
      ...approved,
      call('edit_file', { path: 'PLAN.md', old_string: '- [ ] 3. Report\n', new_string: '' }),
      // Ticking with strike-through and a note keeps the step.
      call('edit_file', {
        path: 'PLAN.md',
        old_string: '- [ ] 2. Core',
        new_string: '- [x] ~~2. Core~~ (done)',
      }),
      call('edit_file', { path: 'PLAN.md', old_string: '1. Skeleton', new_string: '1. Skeleton.' }),
      tick(1),
      { text: 'All done.' },
    ]);

    await run(engine.session(), 'Build the comparator');
    await engine.dispose();

    const output = (index: number) => JSON.stringify(model.requests[index]?.messages.at(-1));
    expect(output(4)).toContain(
      'heaw: this change removed or rewrote a step of PLAN.md that the user approved: \\"3. Report\\". Keep approved steps as they are',
    );
    expect(output(5)).not.toContain('heaw:');
    expect(output(6)).not.toContain('heaw:');
  });

  it('tells a new conversation about a plan with open steps, at its start', async () => {
    const { engine, model, workspace } = await engineWith([{ text: 'On it.' }, { text: 'Yes.' }]);
    await workspace.writeFile('PLAN.md', PLAN.replace('- [ ] 1.', '- [x] 1.'));
    const session = engine.session();

    await run(session, 'Continue the build');
    await run(session, 'Is it done?');
    await engine.dispose();

    expect(JSON.stringify(model.requests[0]?.messages[0])).toContain(
      'PLAN.md has 2 open steps of 3; the next is: 2. Core If this message continues that work, read PLAN.md first',
    );
    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).not.toContain('open step');
  });

  it('leaves the agent alone in a later run about something else, and stops once all is done', async () => {
    const { engine } = await engineWith([
      ...approved,
      tick(1),
      tick(2),
      tick(3),
      { text: 'All three steps are done.' },
      { text: 'There is no UI yet.' },
    ]);
    const session = engine.session();

    const building = await run(session, 'Build the comparator');
    expect(nudges(building)).toHaveLength(0);
    expect(session.buildingPlan).toBe(false);

    const question = await run(session, 'Do we have a UI?');
    await engine.dispose();
    expect(nudges(question)).toHaveLength(0);
  });

  it('starts with /plan go, too', async () => {
    const { engine, workspace } = await engineWith([
      { text: 'Step 1 would be first. Shall I start?' },
      call('read_file', { path: 'PLAN.md' }),
      tick(1),
      { text: 'Step 1 is done.' },
      { text: 'Step 2 needs a decision from you.' },
    ]);
    await workspace.writeFile('PLAN.md', PLAN);
    const session = engine.session();
    const sent: string[] = [];
    const context = {
      engine,
      session: () => session,
      send: (text: string) => sent.push(text),
      print: () => undefined,
      refresh: () => undefined,
    } as unknown as CommandContext;

    await runSlashCommand('/plan go', context);
    const events = await run(session, sent[0]!);
    await engine.dispose();

    // Sent back after asking whether to start, and after step 1; then it waits for the user.
    expect(session.buildingPlan).toBe(true);
    expect(nudges(events)).toHaveLength(2);
  });
});

describe('the reminder to verify', () => {
  it("skips heaw's own config, which check_config verifies, and files no check covers", async () => {
    const { engine } = await engineWith(
      [
        call('write_file', { path: 'heaw.config.ts', content: 'export default {};' }),
        call('write_file', { path: '.mcp.json', content: '{}' }),
        call('write_file', { path: '.gitignore', content: 'target/' }),
        { text: 'Setup written.' },
        call('write_file', { path: 'src/a.ts', content: 'a' }),
        { text: 'Done.' },
        { text: 'Checked.' },
      ],
      { toolsets: ['fs', 'shell'] },
    );
    const session = engine.session();

    const setup = await run(session, 'Write the setup');
    const code = await run(session, 'Write code');
    await engine.dispose();

    expect(setup.filter((event) => event.type === 'hook')).toHaveLength(0);
    expect(nudges(code)).toHaveLength(1);
  });
});

describe('progress kept in a todo list', () => {
  it('counts as progress, so a run that only completed todos is still sent back', async () => {
    const todos = (done: number) =>
      call('todo_write', {
        todos: [1, 2, 3].map((step) => ({
          content: `Step ${step}`,
          status: step <= done ? 'completed' : 'pending',
        })),
      });
    const { engine, model } = await engineWith(
      [
        call('write_file', { path: 'PLAN.md', content: PLAN }),
        todos(1),
        { text: 'Step 1 is done. Next is step 2.' },
        todos(2),
        { text: 'Step 2 is done.' },
        { text: 'I need your input for step 3.' },
      ],
      { toolsets: ['fs', 'plan', 'todo'] },
    );
    const session = engine.session();
    session.buildPlan();

    const events = await run(session, 'Build it');
    await engine.dispose();

    // Sent back after step 1 (approved this run) and after step 2 (a todo completed), with a
    // reminder to tick the steps in PLAN.md.
    expect(nudges(events)).toHaveLength(2);
    expect(JSON.stringify(model.requests[3]?.messages.at(-1))).toContain(
      'Tick each step in PLAN.md as soon as it is done',
    );
  });
});
