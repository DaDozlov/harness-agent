import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/cli/chat/App.js';
import type { Session } from '../../src/core/session.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const KEYS = {
  enter: '\r',
  escape: '\u001b',
  ctrlC: '\u0003',
  shiftTab: '\u001b[Z',
  up: '\u001b[A',
  backspace: '\u007f',
};

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const ui of mounted.splice(0)) ui.unmount();
});

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function startApp(
  responses: ScriptedResponse[],
  options: {
    session?: (engine: Awaited<ReturnType<typeof createEngine>>) => Promise<Session>;
    resumed?: boolean;
    engine?: Partial<Parameters<typeof createEngine>[0]>;
  } = {},
) {
  const workspace = await tempWorkspace();
  const model = new ScriptedModelClient(responses);
  const engine = await createEngine({
    model,
    workspace,
    sessionStore: new JsonlSessionStore(workspace.root),
    ...options.engine,
  });
  const session = options.session ? await options.session(engine) : engine.session();
  const ui = render(<App engine={engine} session={session} resumed={options.resumed ?? false} />);
  mounted.push(ui);
  await tick();
  const frame = () => ui.lastFrame() ?? '';
  const press = async (keys: string, wait = 40) => {
    ui.stdin.write(keys);
    await tick(wait);
  };
  /** Types like a person: one key at a time. */
  const type = async (text: string) => {
    for (const char of text) await press(char, 5);
    await tick();
  };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 100 && !frame().includes(text); i++) await tick(20);
    expect(frame()).toContain(text);
  };
  return { ui, model, engine, session, workspace, frame, press, type, waitFor };
}

describe('chat', () => {
  it('shows the banner, sends a message and streams the answer', async () => {
    const app = await startApp([
      { text: 'Hello! How can I help?', usage: { inputTokens: 900, outputTokens: 300 } },
    ]);
    expect(app.frame()).toContain('/help for commands');
    expect(app.frame()).toContain('scripted:test · default');

    await app.type('Hi there');
    await app.press(KEYS.enter);

    await app.waitFor('Hello! How can I help?');
    expect(app.frame()).toContain('Hi there');
    expect(app.frame()).toContain('1.2k tokens');
    expect(app.model.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('runs slash commands, with suggestions while typing', async () => {
    const app = await startApp([]);

    await app.type('/mo');
    expect(app.frame()).toContain('/model');
    expect(app.frame()).toContain('/mode');

    await app.type('de accept-edits');
    await app.press(KEYS.enter);
    await app.waitFor('Mode: accept-edits.');
    expect(app.frame()).toContain('scripted:test · accept-edits');

    await app.type('/nope');
    await app.press(KEYS.enter);
    await app.waitFor('Unknown command /nope. Type /help to see the commands.');

    await app.type('/help');
    await app.press(KEYS.enter);
    await app.waitFor('Shift+Tab        switch mode');
  });

  it('cycles the permission mode with Shift+Tab, never into bypass', async () => {
    const app = await startApp([]);

    await app.press(KEYS.shiftTab);
    expect(app.frame()).toContain('· accept-edits');
    await app.press(KEYS.shiftTab);
    expect(app.frame()).toContain('· read-only');
    await app.press(KEYS.shiftTab);
    expect(app.frame()).toContain('· default');
    expect(app.session.permissions.mode).toBe('default');
  });

  it('asks before writing a file, shows the content, and runs it once allowed', async () => {
    const app = await startApp([
      {
        toolCalls: [
          { name: 'write_file', args: { path: 'notes.txt', content: 'first line\nsecond line' } },
        ],
      },
      { text: 'Created notes.txt.' },
    ]);

    await app.type('Write notes');
    await app.press(KEYS.enter);

    await app.waitFor('Allow write_file notes.txt?');
    expect(app.frame()).toContain('Asking because write actions are set to "ask" in default mode.');
    expect(app.frame()).toContain('second line');
    expect(app.frame()).toContain('waiting for your approval');

    await app.press('y');

    await app.waitFor('Created notes.txt.');
    expect((await app.workspace.readFile('notes.txt')).toString()).toBe('first line\nsecond line');
    expect(app.frame()).not.toContain('Allow write_file');
  });

  it('denies with feedback, which the model receives', async () => {
    const app = await startApp([
      { toolCalls: [{ name: 'run_command', args: { command: 'rm -rf build' }, id: 'c1' }] },
      { text: 'OK, I will use the clean script.' },
    ]);

    await app.type('Clean up');
    await app.press(KEYS.enter);
    await app.waitFor('$ rm -rf build');

    await app.press('f');
    await app.waitFor('What should heaw do instead?');
    await app.type('use npm run clean');
    await app.press(KEYS.enter);

    await app.waitFor('OK, I will use the clean script.');
    expect(app.model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      output: 'The user denied this action. Their feedback: use npm run clean',
    });
  });

  it('interrupts a running answer with Esc', async () => {
    const app = await startApp([
      { text: 'A very long answer that keeps going and going.', chunkSize: 2, chunkDelayMs: 40 },
    ]);

    await app.type('Tell me everything');
    await app.press(KEYS.enter, 120);
    await app.press(KEYS.escape, 200);

    await app.waitFor('Interrupted.');
    expect(app.frame()).not.toContain('keeps going and going.');
  });

  it('shows parallel sub-agents apart, each with its progress on its delegate line', async () => {
    const reads: ScriptedResponse = {
      toolCalls: ['a', 'b', 'c', 'd', 'e'].map((name) => ({
        name: 'read_file',
        args: { path: `${name}.ts` },
      })),
    };
    const slowReport: ScriptedResponse = {
      text: 'Built the page and its styles.',
      chunkSize: 2,
      chunkDelayMs: 25,
    };
    const app = await startApp(
      [
        {
          toolCalls: [
            { name: 'delegate', args: { agent: 'ui-builder', task: 'Companies page' } },
            { name: 'delegate', args: { agent: 'ui-builder', task: 'Contacts page' } },
          ],
        },
        reads,
        reads,
        reads,
        reads,
        slowReport,
        slowReport,
        { text: 'Both pages are built.' },
      ],
      {
        engine: {
          toolsets: ['fs', 'agents'],
          permissions: { mode: 'accept-edits' },
          agents: [
            {
              name: 'ui-builder',
              description: 'Builds pages.',
              prompt: 'You build pages.',
              tools: ['read_file'],
              source: 'test',
            },
          ],
        },
      },
    );
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await app.workspace.writeFile(`${name}.ts`, `export const ${name} = 1;\n`);
    }

    await app.type('Build both pages');
    await app.press(KEYS.enter);

    // While they work: both numbered, each delegate line with its count and latest call. (Which
    // sub-agent gets which scripted answer depends on timing, so the counts vary.)
    const progress = (n: number) =>
      new RegExp(`ui-builder ${n} · \\d+ calls · read_file [a-e]\\.ts`);
    for (
      let i = 0;
      i < 100 && !(progress(1).test(app.frame()) && progress(2).test(app.frame()));
      i++
    ) {
      await tick(20);
    }
    const running = app.frame();
    expect(running).toMatch(progress(1));
    expect(running).toMatch(progress(2));
    expect(running).toMatch(/ui-builder 1 Companies page/);
    expect(running).toMatch(/ui-builder 2 Contacts page/);
    expect(running).toContain('ui-builder 1 read_file a.ts');

    await app.waitFor('Both pages are built.');
    expect(app.frame()).toMatch(/delegate ui-builder: Companies page/);
  });

  it('asks about approvals from parallel sub-agents one after the other, none lost', async () => {
    const run = { toolCalls: [{ name: 'run_command', args: { command: 'git --version' } }] };
    const app = await startApp(
      [
        {
          toolCalls: [
            { name: 'delegate', args: { task: 'Check git', tools: ['run_command'] }, id: 'd1' },
            { name: 'delegate', args: { task: 'Check git', tools: ['run_command'] }, id: 'd2' },
          ],
        },
        run,
        run,
        { text: 'git is there' },
        { text: 'git is there' },
        { text: 'Both sub-agents are done.' },
      ],
      { engine: { toolsets: ['fs', 'shell', 'agents'] } },
    );

    await app.type('Check git twice');
    await app.press(KEYS.enter);

    await app.waitFor('1 more request is waiting after this one.');
    await app.press('y');
    await app.waitFor('asks: allow run_command git --version?');
    expect(app.frame()).not.toContain('more request is waiting');
    await app.press('y');

    await app.waitFor('Both sub-agents are done.');
    expect(app.session.pendingApprovals).toEqual([]);
  });

  it('shows the earlier conversation when resuming', async () => {
    const workspace = await tempWorkspace();
    const store = new JsonlSessionStore(workspace.root);
    const first = await createEngine({
      model: new ScriptedModelClient([{ text: 'Paris.' }]),
      workspace,
      sessionStore: store,
    });
    const saved = first.session();
    for await (const event of saved.send('Capital of France?')) void event;

    const engine = await createEngine({
      model: new ScriptedModelClient([]),
      workspace,
      sessionStore: store,
    });
    const resumed = await engine.resume(saved.id);
    const ui = render(<App engine={engine} session={resumed} resumed />);
    mounted.push(ui);
    await tick();

    expect(ui.lastFrame()).toContain('Capital of France?');
    expect(ui.lastFrame()).toContain('Paris.');
    expect(ui.lastFrame()).toContain(`Resumed session ${saved.id} (2 messages)`);
  });

  it('edits input: backspace, multi-line with a trailing backslash, and history', async () => {
    const app = await startApp([{ text: 'one' }, { text: 'two' }]);

    await app.type('helo');
    await app.press(KEYS.backspace);
    await app.type('lo\\');
    await app.press(KEYS.enter);
    await app.type('world');
    expect(app.frame()).toContain('hello');
    expect(app.frame()).toContain('world');

    await app.press(KEYS.enter);
    await app.waitFor('one');
    expect(app.model.requests[0]?.messages.at(-1)?.content[0]).toMatchObject({
      text: 'hello\nworld',
    });

    await app.press(KEYS.up);
    expect(app.frame()).toContain('hello');
  });

  it('asks for a second Ctrl+C before exiting, and Ctrl+C clears typed text first', async () => {
    const app = await startApp([]);

    await app.type('draft');
    await app.press(KEYS.ctrlC);
    expect(app.frame()).not.toContain('draft');
    expect(app.frame()).not.toContain('press Ctrl+C again');

    await app.press(KEYS.ctrlC);
    expect(app.frame()).toContain('press Ctrl+C again to exit');
  });
});
