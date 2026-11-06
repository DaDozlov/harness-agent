import { describe, expect, it } from 'vitest';
import { COMMANDS, matchCommands, runSlashCommand } from '../../src/cli/chat/commands.js';
import {
  deleteBackward,
  deleteToLineStart,
  deleteWordBackward,
  EMPTY_INPUT,
  fromText,
  insert,
  moveLeft,
  moveLineEnd,
  moveLineStart,
} from '../../src/cli/chat/input-buffer.js';
import { lastLinesThatFit } from '../../src/cli/chat/components/ItemView.js';
import { approvalPreview } from '../../src/cli/chat/preview.js';
import {
  createTranscript,
  itemsFromHistory,
  type TranscriptAction,
  transcriptReducer,
} from '../../src/cli/chat/transcript.js';
import type { EngineEvent, EngineEventBody } from '../../src/core/events.js';
import { emptyUsage } from '../../src/core/usage.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';

const event = (body: EngineEventBody): TranscriptAction => ({
  type: 'event',
  event: { ...body, sessionId: 's', agentId: 'main', timestamp: 0 } as EngineEvent,
});
const run = (...actions: TranscriptAction[]) =>
  actions.reduce(transcriptReducer, createTranscript(emptyUsage()));

describe('transcript', () => {
  it('streams text into one assistant item and commits it when the message completes', () => {
    const streaming = run(
      { type: 'user', text: 'Hi' },
      event({ type: 'text.delta', text: 'Hel' }),
      event({ type: 'text.delta', text: 'lo' }),
    );

    expect(streaming.items.map((item) => item.kind)).toEqual(['user', 'assistant']);
    expect(streaming.items[1]).toMatchObject({ text: 'Hello', done: false });
    expect(streaming.committed).toBe(1);

    const done = transcriptReducer(
      streaming,
      event({
        type: 'message.complete',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      }),
    );
    expect(done.committed).toBe(2);
  });

  it('shows text that arrived without streaming', () => {
    const state = run(
      event({
        type: 'message.complete',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Whole' }] },
      }),
    );
    expect(state.items).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Whole', done: true }),
    ]);
  });

  it('tracks a tool through approval to its result, keeping it live until it ends', () => {
    const started = run(
      event({
        type: 'tool.start',
        callId: 'c1',
        tool: 'write_file',
        args: { path: 'a.txt', content: 'x' },
      }),
      event({
        type: 'approval.request',
        requestId: 'r',
        callId: 'c1',
        tool: 'write_file',
        args: {},
        subject: 'a.txt',
        reason: 'x',
      }),
    );
    expect(started.items[0]).toMatchObject({ label: 'write_file a.txt', status: 'approval' });
    expect(started.committed).toBe(0);

    const ended = [
      event({
        type: 'approval.response',
        requestId: 'r',
        decision: { allow: true, scope: 'once' },
      }),
      event({
        type: 'tool.end',
        callId: 'c1',
        tool: 'write_file',
        output: 'Created a.txt',
        status: 'ok',
        isError: false,
        durationMs: 5,
      }),
    ].reduce(transcriptReducer, started);
    expect(ended.items[0]).toMatchObject({ status: 'ok', output: 'Created a.txt' });
    expect(ended.committed).toBe(1);
  });

  it('adds notices for errors and for runs that did not end normally', () => {
    const state = run(
      event({
        type: 'error',
        error: { name: 'ModelError', message: 'Rate limited', status: 429 },
        recoverable: true,
      }),
      event({ type: 'run.end', stopReason: 'aborted', usage: emptyUsage(), turns: 1 }),
    );
    expect(state.items.map((item) => item.kind === 'notice' && [item.tone, item.text])).toEqual([
      ['warning', 'Model call failed (429), retrying: Rate limited'],
      ['info', 'Interrupted.'],
    ]);
  });

  it('adds up usage', () => {
    const usage = { ...emptyUsage(), inputTokens: 10, outputTokens: 5 };
    const state = run(event({ type: 'usage', usage }), event({ type: 'usage', usage }));
    expect(state.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('rebuilds items from a saved history, with tool results', () => {
    const items = itemsFromHistory([
      { role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running.' },
          { type: 'tool-call', id: 'c1', name: 'run_command', args: { command: 'npm test' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            callId: 'c1',
            name: 'run_command',
            output: 'fail\n\n[exit code 1]',
            isError: true,
          },
        ],
      },
    ]);
    expect(
      items.map((item) => [
        item.kind,
        item.kind === 'tool' ? item.status : 'text' in item ? item.text : '',
      ]),
    ).toEqual([
      ['user', 'Run tests'],
      ['assistant', 'Running.'],
      ['tool', 'error'],
    ]);
  });
});

describe('input buffer', () => {
  it('inserts at the cursor and normalizes pasted line endings', () => {
    expect(insert(moveLeft(fromText('ac')), 'b')).toEqual({ text: 'abc', cursor: 2 });
    expect(insert(EMPTY_INPUT, 'a\r\nb\rc')).toEqual({ text: 'a\nb\nc', cursor: 5 });
  });

  it('deletes characters, words and lines', () => {
    expect(deleteBackward(fromText('abc'))).toEqual({ text: 'ab', cursor: 2 });
    expect(deleteBackward(EMPTY_INPUT)).toBe(EMPTY_INPUT);
    expect(deleteWordBackward(fromText('run the tests  '))).toEqual({
      text: 'run the ',
      cursor: 8,
    });
    expect(deleteToLineStart(fromText('first\nsecond'))).toEqual({ text: 'first\n', cursor: 6 });
  });

  it('moves within the current line', () => {
    const buffer = { text: 'one\ntwo\nthree', cursor: 5 };
    expect(moveLineStart(buffer).cursor).toBe(4);
    expect(moveLineEnd(buffer).cursor).toBe(7);
  });
});

describe('slash commands', () => {
  async function context() {
    const engine = await createEngine({ model: new ScriptedModelClient([]), toolsets: [] });
    const session = engine.session();
    const printed: Array<[string, string]> = [];
    return {
      session,
      printed,
      ctx: {
        engine,
        session: () => session,
        print: (text: string, tone: 'info' | 'warning' | 'error' = 'info') =>
          printed.push([tone, text]),
        newSession: () => printed.push(['info', 'NEW']),
        refresh: () => undefined,
        exit: () => printed.push(['info', 'EXIT']),
      },
    };
  }

  it('matches commands by prefix, for suggestions', () => {
    expect(matchCommands('/mo').map((command) => command.name)).toEqual(['model', 'mode']);
    expect(matchCommands('/mode x')).toEqual([]);
    expect(matchCommands('hello')).toEqual([]);
  });

  it('switches the mode, warning about bypass and rejecting unknown modes', async () => {
    const { session, printed, ctx } = await context();

    await runSlashCommand('/mode bypass', ctx);
    expect(session.permissions.mode).toBe('bypass');
    expect(printed.at(-1)?.[0]).toBe('warning');

    await runSlashCommand('/mode yolo', ctx);
    expect(printed.at(-1)).toEqual([
      'error',
      'Unknown mode "yolo". Use one of: default, accept-edits, read-only, bypass.',
    ]);
  });

  it('reports a model that cannot be created, keeping the current one', async () => {
    const { session, printed, ctx } = await context();

    await runSlashCommand('/model azure:missing-credentials', ctx);

    expect(session.model.id).toBe('scripted:test');
    expect(printed.at(-1)?.[0]).toBe('error');
  });

  it('supports aliases and explains unknown commands', async () => {
    const { printed, ctx } = await context();

    await runSlashCommand('/quit', ctx);
    await runSlashCommand('/frobnicate', ctx);

    expect(printed).toEqual([
      ['info', 'EXIT'],
      ['error', 'Unknown command /frobnicate. Type /help to see the commands.'],
    ]);
  });

  it('documents every command in /help', async () => {
    const { printed, ctx } = await context();
    await runSlashCommand('/help', ctx);
    for (const command of COMMANDS) expect(printed[0]?.[1]).toContain(`/${command.name}`);
  });
});

describe('approval preview', () => {
  it('shows the first two of several edits, and how many more', () => {
    const edit = (n: number) => ({ old_string: `old ${n}`, new_string: `new ${n}` });

    expect(
      approvalPreview('edit_file', { path: 'a.ts', edits: [edit(1), edit(2), edit(3)] }),
    ).toEqual([
      { text: 'Edit 1 of 3:', color: 'gray' },
      { text: '- old 1', color: 'red' },
      { text: '+ new 1', color: 'green' },
      { text: 'Edit 2 of 3:', color: 'gray' },
      { text: '- old 2', color: 'red' },
      { text: '+ new 2', color: 'green' },
      { text: '… 1 more edit', color: 'gray' },
    ]);
  });

  it('shows the command, the new content, or the change', () => {
    expect(approvalPreview('run_command', { command: 'npm test' })).toEqual([
      { text: '$ npm test' },
    ]);
    expect(approvalPreview('web_fetch', { url: 'https://example.com/a' })).toEqual([
      { text: 'GET https://example.com/a' },
    ]);
    expect(
      approvalPreview('http_request', {
        method: 'POST',
        url: 'https://api.example.com/v1/items',
        json: { name: 'a' },
      }),
    ).toEqual([
      { text: 'POST https://api.example.com/v1/items' },
      { text: '{', color: 'gray' },
      { text: '  "name": "a"', color: 'gray' },
      { text: '}', color: 'gray' },
    ]);
    expect(
      approvalPreview('edit_file', { path: 'a', old_string: 'x = 1', new_string: 'x = 2' }),
    ).toEqual([
      { text: '- x = 1', color: 'red' },
      { text: '+ x = 2', color: 'green' },
    ]);
    const long = approvalPreview('write_file', {
      path: 'a',
      content: Array(15).fill('line').join('\n'),
    });
    expect(long).toHaveLength(11);
    expect(long.at(-1)).toEqual({ text: '… 5 more lines', color: 'gray' });
  });
});

describe('streaming long answers', () => {
  const delta = (text: string) => event({ type: 'text.delta', text });
  const complete = (text: string) =>
    event({
      type: 'message.complete',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  const assistantTexts = (state: ReturnType<typeof run>) =>
    state.items.flatMap((item) => (item.kind === 'assistant' ? [[item.text, item.done]] : []));

  it('moves finished paragraphs out of the live area while the rest streams', () => {
    const state = run(delta('First paragraph.\n\nSecond'), delta(' paragraph.\n\nThi'));

    expect(assistantTexts(state)).toEqual([
      ['First paragraph.', true],
      ['Second paragraph.', true],
      ['Thi', false],
    ]);
    expect(state.committed).toBe(2);
  });

  it('keeps a code block together until it closes, even across blank lines', () => {
    const open = run(delta('Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n'));
    expect(assistantTexts(open)).toEqual([
      ['Intro.', true],
      ['```ts\nconst a = 1;\n\nconst b = 2;\n', false],
    ]);

    const closed = transcriptReducer(open, delta('```\n\nAfter.'));
    expect(assistantTexts(closed)).toEqual([
      ['Intro.', true],
      ['```ts\nconst a = 1;\n\nconst b = 2;\n```', true],
      ['After.', false],
    ]);
  });

  it('never shows streamed text twice, even when it ends on a paragraph break', () => {
    const state = run(delta('One.\n\nTwo.\n\n'), complete('One.\n\nTwo.\n\n'));

    // One finished item (both paragraphs), and nothing shown a second time.
    expect(assistantTexts(state)).toEqual([['One.\n\nTwo.', true]]);
  });
});

describe('lastLinesThatFit', () => {
  it('keeps text that fits and cuts the start of text that does not', () => {
    expect(lastLinesThatFit('a\nb', 5, 80)).toBe('a\nb');
    expect(lastLinesThatFit('1\n2\n3\n4\n5\n6', 4, 80)).toBe('…\n4\n5\n6');
  });

  it('counts lines that wrap, ignoring color codes', () => {
    const long = 'x'.repeat(25); // 3 screen lines at width 10
    expect(lastLinesThatFit(`a\nb\n${long}`, 4, 10)).toBe(`…\n${long}`);
    expect(lastLinesThatFit('\u001b[31mred\u001b[39m', 2, 3)).toBe('\u001b[31mred\u001b[39m');
  });
});

describe('repeated text and heaw reminders', () => {
  it('shows a final answer that repeats an earlier text of the same message once', () => {
    const items = itemsFromHistory([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Step 1 is done.' },
          { type: 'text', text: 'Step 1 is done.' },
          { type: 'text', text: 'Step 2 is next.' },
        ],
      },
    ]);
    expect(items.map((item) => ('text' in item ? item.text : ''))).toEqual([
      'Step 1 is done.',
      'Step 2 is next.',
    ]);
  });

  it("shows heaw's own reminder as such, not as a failed check", () => {
    const state = run(
      event({
        type: 'hook',
        hook: 'beforeStop',
        message: 'PLAN.md still has 2 open steps; the next is: 2. Core',
        builtIn: true,
      }),
    );
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Not done yet, so the agent goes on: PLAN.md still has 2 open steps; the next is: 2. Core',
    });
  });
});
