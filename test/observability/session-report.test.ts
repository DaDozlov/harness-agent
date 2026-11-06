import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { retroPrompt } from '../../src/cli/chat/commands.js';
import type { ModelRequest } from '../../src/core/model.js';
import { createEngine } from '../../src/engine.js';
import {
  runSteps,
  sessionReport,
  sessionReportTool,
} from '../../src/observability/session-report.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { RETRO_SKILL } from '../../src/skills/built-in.js';
import { defineTool } from '../../src/tools/define.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

const check = defineTool({
  name: 'check',
  description: 'Run the checks',
  kind: 'read',
  parameters: z.object({}),
  run: () => ({ output: 'FAIL src/a.test.ts\n1 test failed\n\n[exit code 1]', isError: true }),
});

const call = (name: string, args: unknown = {}): ScriptedResponse => ({
  toolCalls: [{ name, args }],
});
const lastOutput = (request: ModelRequest | undefined) => {
  const message = request?.messages.at(-1);
  return message?.role === 'tool' ? message.content.map((part) => part.output).join('\n') : '';
};

async function setup(responses: ScriptedResponse[]) {
  const workspace = await tempWorkspace();
  const store = new JsonlSessionStore(workspace.root);
  const model = new ScriptedModelClient(responses);
  const engine = await createEngine({
    model,
    workspace,
    toolsets: ['fs'],
    tools: [check, sessionReportTool(store)],
    interactive: false,
    git: false,
    sessionStore: store,
  });
  return { engine, model, store };
}

describe('the session report', () => {
  it('sums up runs, failures, denials and where heaw stepped in; and one run step by step', async () => {
    const { engine, store } = await setup([
      call('check'),
      call('check'),
      call('check'),
      { text: 'The test still fails.' },
      call('write_file', { path: 'notes.txt', content: 'x' }),
      { text: 'I may not write files here.' },
    ]);
    const session = engine.session();
    await collect(session.send('Fix the tests'));
    await collect(session.send('Write notes'));
    await session.close();
    await engine.dispose();

    const records = await store.load(session.id);
    const report = sessionReport(session.id, records);

    expect(report).toContain(`# Session ${session.id}`);
    expect(report).toContain('2 runs · 6 turns of the main agent · 6 model calls');
    expect(report).toContain('1. ');
    expect(report).toContain('"Fix the tests"\n   → end_turn · 4 turns');
    expect(report).toContain('3 calls (3 failed)');
    expect(report).toContain('going in circles 1×');
    expect(report).toContain('## Denied (1)');
    expect(report).toContain('[main] write_file notes.txt: rule: this action needs approval');
    expect(report).toContain('## Failed calls (3)');
    expect(report).toContain(
      '- check ×3, 3× with the same output [main]: exit code 1: FAIL src/a.test.ts',
    );
    expect(report).toContain(
      '## heaw stepped in\n- [main] going in circles: check (failed the same way 3×)',
    );
    expect(report).toContain(
      '## Calls repeated with the same arguments (2 repeats)\n- [main] check ×3',
    );

    const steps = runSteps(records, 1);
    expect(steps).toContain('# Run 1 of 2, step by step');
    expect(steps).toContain('the user: "Fix the tests"');
    expect(steps).toContain('[main t1] check\n   → error: exit code 1: FAIL src/a.test.ts');
    expect(steps).toContain('heaw → [main] going in circles: check (3×)');
    expect(steps).toContain('[main] says: The test still fails.');
    expect(runSteps(records, 9)).toBe('There is no run 9; this session has 2.');
  });

  it('reviews the last session by default, and this one once it has earlier runs', async () => {
    const { engine, model } = await setup([
      { text: 'Hello.' },
      call('session_report'),
      { text: 'Reviewed the last session.' },
      call('session_report'),
      { text: 'Reviewed this one.' },
    ]);
    const earlier = engine.session();
    await collect(earlier.send('Say hello'));
    await earlier.close();

    const review = engine.session();
    await collect(review.send('/retro'));
    await collect(review.send('And this conversation?'));
    await engine.dispose();

    const first = lastOutput(model.requests[2]);
    expect(first).toContain(`# Session ${earlier.id}`);
    expect(first).toContain('"Say hello"');
    const second = lastOutput(model.requests[4]);
    expect(second).toContain(`# Session ${review.id}`);
    expect(second).toContain('1 run ·'); // the run in progress, this review, is left out
    expect(second).toContain(`Other sessions:\n- ${earlier.id}: 1 run`);
  });
});

describe('/retro', () => {
  it('asks for the retro skill, with a session id or notes', () => {
    expect(retroPrompt('')).toBe(
      'Review how the work in a session went and turn what went wrong into lasting fixes: load the retro skill and follow it.',
    );
    expect(retroPrompt('20261106-1004 the tests')).toMatch(
      /Session: 20261106-1004\. Notes: the tests$/,
    );
    expect(retroPrompt('focus on the tests')).toMatch(/follow it\. Notes: focus on the tests$/);
    expect(RETRO_SKILL.content).toContain('Call `session_report`');
  });
});
