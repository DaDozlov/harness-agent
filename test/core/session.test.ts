import { describe, expect, it } from 'vitest';
import { ModelError } from '../../src/core/errors.js';
import type { EngineEvent } from '../../src/core/events.js';
import { textOf } from '../../src/core/messages.js';
import { Session, type SessionOptions } from '../../src/core/session.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';

const NO_DELAY = { initialDelayMs: 0, maxDelayMs: 0 };

function setup(responses: ScriptedResponse[], options: Partial<SessionOptions> = {}) {
  const model = new ScriptedModelClient(responses);
  const session = new Session({
    model,
    system: 'Be brief.',
    ...options,
    retry: { ...NO_DELAY, ...options.retry },
  });
  return { model, session };
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function runEnd(events: EngineEvent[]) {
  const last = events.at(-1);
  if (last?.type !== 'run.end') throw new Error(`Last event is ${last?.type}, not run.end`);
  return last;
}

function streamedText(events: EngineEvent[]): string {
  return events.map((event) => (event.type === 'text.delta' ? event.text : '')).join('');
}

describe('Session', () => {
  it('streams the answer and ends the run', async () => {
    const { model, session } = setup([
      { text: 'Hello! How can I help?', usage: { inputTokens: 10, outputTokens: 7 } },
    ]);

    const events = await collect(session.send('Hi'));

    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'turn.start',
      'text.delta',
      'text.delta',
      'text.delta',
      'message.complete',
      'usage',
      'run.end',
    ]);
    expect(streamedText(events)).toBe('Hello! How can I help?');
    expect(runEnd(events)).toMatchObject({
      stopReason: 'end_turn',
      turns: 1,
      usage: { inputTokens: 10, outputTokens: 7 },
    });
    expect(events.every((e) => e.sessionId === session.id && e.agentId === 'main')).toBe(true);
    expect(model.requests[0]).toMatchObject({ system: 'Be brief.' });
    expect(session.messages.map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello! How can I help?'],
    ]);
  });

  it('keeps the conversation history across runs and totals usage', async () => {
    const { model, session } = setup([
      { text: 'Paris.', usage: { inputTokens: 5, outputTokens: 2 } },
      { text: 'About 2 million.', usage: { inputTokens: 9, outputTokens: 4 } },
    ]);

    await collect(session.send('Capital of France?'));
    await collect(session.send('Population?'));

    expect(model.requests[1]?.messages.map(textOf)).toEqual([
      'Capital of France?',
      'Paris.',
      'Population?',
    ]);
    expect(session.usage).toMatchObject({ inputTokens: 14, outputTokens: 6 });
  });

  it('retries a retryable error that happens before any output', async () => {
    const rateLimited = new ModelError('Rate limited', { retryable: true, status: 429 });
    const { model, session } = setup([{ error: rateLimited }, { text: 'ok' }]);

    const events = await collect(session.send('Hi'));

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      recoverable: true,
      error: { message: 'Rate limited', status: 429 },
    });
    expect(streamedText(events)).toBe('ok');
    expect(runEnd(events).stopReason).toBe('end_turn');
    expect(model.requests).toHaveLength(2);
  });

  it('gives up after the retry limit', async () => {
    const overloaded = () => new ModelError('Overloaded', { retryable: true, status: 529 });
    const { model, session } = setup([{ error: overloaded() }, { error: overloaded() }], {
      retry: { maxRetries: 1 },
    });

    const events = await collect(session.send('Hi'));

    expect(model.requests).toHaveLength(2);
    expect(events.at(-2)).toMatchObject({ type: 'error', recoverable: false });
    expect(runEnd(events).stopReason).toBe('error');
  });

  it('does not retry errors that are not retryable', async () => {
    const unauthorized = new ModelError('Invalid API key', { retryable: false, status: 401 });
    const { model, session } = setup([{ error: unauthorized }, { text: 'never used' }]);

    const events = await collect(session.send('Hi'));

    expect(model.requests).toHaveLength(1);
    expect(events.at(-2)).toMatchObject({ type: 'error', error: { status: 401 } });
    expect(runEnd(events).stopReason).toBe('error');
  });

  it('does not retry once output has streamed, so nothing is shown twice', async () => {
    const dropped = new ModelError('Connection reset', { retryable: true });
    const { model, session } = setup([
      { text: 'Partial answer', errorAfterText: dropped },
      { text: 'never used' },
    ]);

    const events = await collect(session.send('Hi'));

    expect(model.requests).toHaveLength(1);
    expect(runEnd(events).stopReason).toBe('error');
  });

  it('stops when aborted mid-answer and keeps the partial text in the history', async () => {
    const { session } = setup([
      { text: 'This answer is long and gets interrupted.', chunkSize: 4, chunkDelayMs: 5 },
    ]);
    const controller = new AbortController();
    const events: EngineEvent[] = [];

    for await (const event of session.send('Hi', { signal: controller.signal })) {
      events.push(event);
      if (event.type === 'text.delta') controller.abort();
    }

    expect(runEnd(events).stopReason).toBe('aborted');
    expect(streamedText(events)).toBe('This');
    expect(session.messages.map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'This'],
    ]);
  });

  it('answers calls to unknown tools with an error result, then continues', async () => {
    const { model, session } = setup([
      { toolCalls: [{ name: 'read_file', args: { path: 'a.ts' }, id: 'call_1' }] },
      { text: 'I cannot read files yet.' },
    ]);

    const events = await collect(session.send('Read a.ts'));

    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({
      callId: 'call_1',
      tool: 'read_file',
      isError: true,
    });
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          callId: 'call_1',
          name: 'read_file',
          output: 'Unknown tool "read_file". Available tools: none.',
          isError: true,
        },
      ],
    });
    expect(runEnd(events)).toMatchObject({ stopReason: 'end_turn', turns: 2 });
  });

  it('stops at the turn limit', async () => {
    const { session } = setup([{ toolCalls: [{ name: 'read_file' }] }], {
      limits: { maxTurns: 1 },
    });

    const events = await collect(session.send('Read everything'));

    expect(runEnd(events)).toMatchObject({ stopReason: 'max_turns', turns: 1 });
  });

  it('reports an answer cut off by the output limit', async () => {
    const { session } = setup([{ text: 'Once upon a', finishReason: 'length' }]);

    const events = await collect(session.send('Tell a story'));

    expect(runEnd(events).stopReason).toBe('max_tokens');
  });

  it('refuses a second run while one is in progress', async () => {
    const { session } = setup([{ text: 'Slow answer', chunkDelayMs: 5 }, { text: 'x' }]);

    const first = session.send('One');
    await first.next();

    await expect(session.send('Two').next()).rejects.toThrow('already running');
    await first.return(undefined as never);
  });
});
