import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EngineEvent } from '../../src/core/events.js';
import type { PermissionRules } from '../../src/core/permissions.js';
import { Session } from '../../src/core/session.js';
import type { Tool } from '../../src/core/tools.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { defineTool } from '../../src/tools/define.js';
import { FS_TOOLS } from '../../src/tools/fs.js';
import { runCommand } from '../../src/tools/shell.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

async function setup(
  responses: ScriptedResponse[],
  options: {
    tools?: Tool[];
    permissions?: PermissionRules;
    interactive?: boolean;
    maxToolOutputChars?: number;
  } = {},
) {
  const workspace = await tempWorkspace();
  const model = new ScriptedModelClient(responses);
  const session = new Session({
    model,
    system: 'test',
    workspace,
    tools: options.tools ?? [...FS_TOOLS, runCommand],
    permissions: options.permissions,
    interactive: options.interactive ?? false,
    maxToolOutputChars: options.maxToolOutputChars,
  });
  return { workspace, model, session };
}

const call = (name: string, args: unknown, id = `call_${name}`) => ({ name, args, id });
const ofType = <T extends EngineEvent['type']>(events: EngineEvent[], type: T) =>
  events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
const lastToolResults = (model: ScriptedModelClient) =>
  model.requests.at(-1)?.messages.at(-1)?.content;

describe('tool execution', () => {
  it('runs a tool and gives the result to the model', async () => {
    const { workspace, model, session } = await setup([
      { toolCalls: [call('read_file', { path: 'notes.txt' })] },
      { text: 'It says hello.' },
    ]);
    await workspace.writeFile('notes.txt', 'hello');

    const events = await collect(session.send('What is in notes.txt?'));

    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain('read_file');
    expect(ofType(events, 'tool.end')[0]).toMatchObject({
      tool: 'read_file',
      status: 'ok',
      output: '     1\thello',
    });
    expect(lastToolResults(model)).toEqual([
      { type: 'tool-result', callId: 'call_read_file', name: 'read_file', output: '     1\thello' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'end_turn', turns: 2 });
  });

  it('answers unknown tools, invalid arguments and tool errors with error results', async () => {
    const { model, session } = await setup([
      {
        toolCalls: [
          call('fly', {}),
          call('read_file', { path: 42 }),
          call('read_file', { path: 'missing.txt' }, 'call_missing'),
        ],
      },
      { text: 'I see.' },
    ]);

    await collect(session.send('Try things'));

    expect(lastToolResults(model)).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.stringMatching(
          /^Unknown tool "fly"\. Available tools: read_file, /,
        ) as unknown,
      }),
      expect.objectContaining({
        isError: true,
        output: expect.stringContaining('Invalid arguments for read_file') as unknown,
      }),
      expect.objectContaining({ isError: true, output: 'Error: missing.txt does not exist.' }),
    ]);
  });

  it('denies calls matching a deny rule without running them', async () => {
    const { workspace, session } = await setup(
      [{ toolCalls: [call('read_file', { path: '.env' })] }, { text: 'ok' }],
      { permissions: { deny: ['read_file(**/.env*)'] } },
    );
    await workspace.writeFile('.env', 'SECRET=1');

    const events = await collect(session.send('Read .env'));

    expect(ofType(events, 'tool.end')[0]).toMatchObject({
      status: 'denied',
      output: 'Permission denied: it matches the deny rule "read_file(**/.env*)".',
    });
  });

  it('denies actions that need approval in a non-interactive run, saying how to allow them', async () => {
    const { workspace, session } = await setup([
      { toolCalls: [call('write_file', { path: 'a.txt', content: 'x' })] },
      { text: 'ok' },
    ]);

    const events = await collect(session.send('Write a.txt'));

    expect(ofType(events, 'tool.end')[0]).toMatchObject({
      status: 'denied',
      output:
        'Permission denied: this action needs approval because write actions are set to "ask" ' +
        'in default mode, and this run cannot ask the user. To allow this exact call, the user ' +
        'can run again with the rule "write_file(a.txt)".',
    });
    expect(await workspace.stat('a.txt')).toBeUndefined();
  });

  it('tells a denied model which calls of that tool are allowed instead', async () => {
    const { model, session } = await setup(
      [{ toolCalls: [call('run_command', { command: 'pytest -q' })] }, { text: 'ok' }],
      { permissions: { allow: ['run_command(npm test*)', 'read_file(src/**)'] } },
    );

    await collect(session.send('Run the tests'));

    expect(lastToolResults(model)).toEqual([
      expect.objectContaining({
        output: expect.stringContaining(
          'cannot ask the user. These run_command calls are allowed in this run: run_command(npm test*).',
        ) as unknown,
      }),
    ]);
  });

  it('asks for approval and runs the call once it is allowed', async () => {
    const { workspace, session } = await setup(
      [{ toolCalls: [call('write_file', { path: 'a.txt', content: 'x' })] }, { text: 'Done.' }],
      { interactive: true },
    );
    const events: EngineEvent[] = [];

    for await (const event of session.send('Write a.txt')) {
      events.push(event);
      if (event.type === 'approval.request') {
        expect(event).toMatchObject({ tool: 'write_file', subject: 'a.txt' });
        session.approve(event.requestId, { allow: true, scope: 'once' });
      }
    }

    expect(ofType(events, 'approval.response')[0]?.decision).toEqual({
      allow: true,
      scope: 'once',
    });
    expect(ofType(events, 'tool.end')[0]?.status).toBe('ok');
    expect((await workspace.readFile('a.txt')).toString()).toBe('x');
  });

  it('tells the model when the user denies, including their feedback', async () => {
    const { model, session } = await setup(
      [{ toolCalls: [call('run_command', { command: 'rm -rf build' })] }, { text: 'Understood.' }],
      { interactive: true },
    );

    for await (const event of session.send('Clean up')) {
      if (event.type === 'approval.request') {
        session.approve(event.requestId, { allow: false, feedback: 'Use npm run clean instead.' });
      }
    }

    expect(lastToolResults(model)).toEqual([
      expect.objectContaining({
        isError: true,
        output: 'The user denied this action. Their feedback: Use npm run clean instead.',
      }),
    ]);
  });

  it('remembers "allow for this session" for the exact same call', async () => {
    const echo = call('run_command', { command: 'echo hi' });
    const { session } = await setup(
      [
        { toolCalls: [{ ...echo, id: 'c1' }] },
        { toolCalls: [{ ...echo, id: 'c2' }] },
        { toolCalls: [call('run_command', { command: 'echo bye' }, 'c3')] },
        { text: 'done' },
      ],
      { interactive: true },
    );
    const asked: string[] = [];

    for await (const event of session.send('Echo')) {
      if (event.type === 'approval.request') {
        asked.push(event.callId);
        session.approve(event.requestId, { allow: true, scope: 'session' });
      }
    }

    expect(asked).toEqual(['c1', 'c3']);
  });

  it('runs read tools in parallel and other tools one at a time, in order', async () => {
    const log: string[] = [];
    const slow = (name: string, kind: 'read' | 'write') =>
      defineTool({
        name,
        description: name,
        kind,
        parameters: z.object({}),
        async run() {
          log.push(`${name} start`);
          await sleep(30);
          log.push(`${name} end`);
          return name;
        },
      });
    const { session } = await setup(
      [
        {
          toolCalls: [
            call('read_a', {}),
            call('read_b', {}),
            call('write_c', {}),
            call('read_d', {}),
          ],
        },
        { text: 'ok' },
      ],
      {
        tools: [
          slow('read_a', 'read'),
          slow('read_b', 'read'),
          slow('write_c', 'write'),
          slow('read_d', 'read'),
        ],
        permissions: { mode: 'bypass' },
      },
    );

    await collect(session.send('Go'));

    expect(log).toEqual([
      'read_a start',
      'read_b start',
      'read_a end',
      'read_b end',
      'write_c start',
      'write_c end',
      'read_d start',
      'read_d end',
    ]);
  });

  it('cancels every call when aborted during an approval, keeping the history valid', async () => {
    const { model, session } = await setup(
      [
        {
          toolCalls: [
            call('write_file', { path: 'a', content: '' }, 'c1'),
            call('read_file', { path: 'b' }, 'c2'),
          ],
        },
        { text: 'never' },
      ],
      { interactive: true },
    );
    const controller = new AbortController();

    const events: EngineEvent[] = [];
    for await (const event of session.send('Go', { signal: controller.signal })) {
      events.push(event);
      if (event.type === 'approval.request') controller.abort();
    }

    expect(ofType(events, 'tool.end').map((e) => [e.callId, e.status])).toEqual([
      ['c1', 'cancelled'],
      ['c2', 'cancelled'],
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'aborted' });
    expect(model.requests).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ callId: 'c1' }, { callId: 'c2' }],
    });
  });

  it('shortens huge output and saves the full text in a git-ignored folder', async () => {
    const huge = defineTool({
      name: 'huge',
      description: 'huge',
      kind: 'read',
      parameters: z.object({}),
      run: () => `${'a'.repeat(5_000)}${'z'.repeat(5_000)}`,
    });
    const { workspace, model, session } = await setup(
      [{ toolCalls: [call('huge', {})] }, { text: 'ok' }],
      { tools: [huge, ...FS_TOOLS], maxToolOutputChars: 1_000 },
    );

    await collect(session.send('Go'));

    const output = (lastToolResults(model)?.[0] as { output: string }).output;
    const savedTo = `.heaw/sessions/${session.id}/outputs/call_huge.txt`;
    expect(output).toMatch(/^a{600}\n\n\[9000 characters omitted\. The full output is in /);
    expect(output).toContain(savedTo);
    expect(output.endsWith('z'.repeat(400))).toBe(true);
    expect((await workspace.readFile(savedTo)).toString()).toHaveLength(10_000);
    expect(
      (await workspace.readFile(`.heaw/sessions/${session.id}/outputs/.gitignore`)).toString(),
    ).toBe('*\n');
  });

  it("cuts a tool's output at its own smaller limit, keeping mostly the end", async () => {
    const chatty = defineTool({
      name: 'chatty',
      description: 'chatty',
      kind: 'read',
      output: { maxChars: 1_000, headShare: 0.25 },
      parameters: z.object({}),
      run: () => `${'a'.repeat(5_000)}${'z'.repeat(5_000)}`,
    });
    const { model, session } = await setup([{ toolCalls: [call('chatty', {})] }, { text: 'ok' }], {
      tools: [chatty, ...FS_TOOLS],
    });

    await collect(session.send('Go'));

    const output = (lastToolResults(model)?.[0] as { output: string }).output;
    expect(output).toMatch(/^a{250}\n\n\[9000 characters omitted\./);
    expect(output.endsWith(`\n\n${'z'.repeat(750)}`)).toBe(true);
    // Commands keep a quarter from the start, three quarters from the end.
    expect(runCommand.output).toEqual({ maxChars: 12_000, headShare: 0.25 });
  });
});

describe('createEngine with tools', () => {
  it('enables the built-in toolsets by default and describes the workspace to the model', async () => {
    const workspace = await tempWorkspace();
    const model = new ScriptedModelClient([{ text: 'ok' }]);
    const engine = await createEngine({ model, workspace });

    await collect(engine.session().send('Hi'));

    const request = model.requests[0]!;
    expect(request.tools?.map((t) => t.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'glob',
      'grep',
      'run_command',
      'command_output',
      'stop_command',
      'web_fetch',
      'todo_write',
      'start_plan',
      'finish_plan',
      'delegate',
      'remember',
    ]);
    expect(request.system).toContain('Change existing files with edit_file');
    expect(request.system).toContain(`Working directory: ${workspace.root}`);
    expect(request.system).toContain(`Shell for run_command: ${workspace.shell}`);
  });

  it('tells the model when a run is one-shot, so it finishes instead of asking', async () => {
    const interactive = new ScriptedModelClient([{ text: 'ok' }]);
    const oneShot = new ScriptedModelClient([{ text: 'ok' }]);

    await collect((await createEngine({ model: interactive, toolsets: [] })).session().send('Hi'));
    await collect(
      (await createEngine({ model: oneShot, toolsets: [], interactive: false }))
        .session()
        .send('Hi'),
    );

    expect(interactive.requests[0]?.system).not.toContain('non-interactive');
    expect(oneShot.requests[0]?.system).toContain(
      'This run is non-interactive: the user cannot reply',
    );
  });

  it('can run without tools', async () => {
    const model = new ScriptedModelClient([{ text: 'ok' }]);
    const engine = await createEngine({ model, toolsets: [] });

    await collect(engine.session().send('Hi'));

    expect(model.requests[0]?.tools).toBeUndefined();
    expect(model.requests[0]?.system).not.toContain('edit_file');
  });

  it('rejects invalid permission rules and unknown toolsets up front', async () => {
    const model = new ScriptedModelClient([]);
    await expect(createEngine({ model, permissions: { allow: ['bad rule('] } })).rejects.toThrow(
      'Invalid permission rule',
    );
    await expect(createEngine({ model, toolsets: ['browser' as never] })).rejects.toThrow(
      'Unknown toolset "browser"',
    );
  });
});
