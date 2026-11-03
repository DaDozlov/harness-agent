import { describe, expect, it } from 'vitest';
import {
  clearOldToolResults,
  compactHistory,
  ContextMeter,
  estimateRequest,
  estimateTokens,
  SUMMARY_PREFIX,
} from '../../src/core/context.js';
import type { EngineEvent } from '../../src/core/events.js';
import { HookRunner } from '../../src/core/hooks.js';
import { type Message, textOf, userMessage } from '../../src/core/messages.js';
import { Session } from '../../src/core/session.js';
import { restoreSession } from '../../src/core/session-store.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { collect, tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
/** 2,000 usable input tokens: compaction starts at 1,600. */
const SMALL = { contextWindow: 3_000, maxOutputTokens: 1_000 };

/** A turn in which the agent reads a file: a tool call and its (long) result. */
function exchange(index: number, outputChars = 2_000): Message[] {
  const id = `call-${index}`;
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id, name: 'read_file', args: { path: `f${index}` } }],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', callId: id, name: 'read_file', output: 'x'.repeat(outputChars) },
      ],
    },
  ];
}

function history(exchanges: number, outputChars?: number): Message[] {
  return [
    userMessage('Refactor the parser.'),
    ...Array.from({ length: exchanges }, (_, index) => exchange(index, outputChars)).flat(),
  ];
}

const hookContext = {
  sessionId: 's',
  agentId: 'main',
  model: 'scripted:test',
  workspace: undefined as never,
  signal: new AbortController().signal,
};

describe('token estimates', () => {
  it('counts about four characters per token and learns from the provider', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    const request = { system: 'x'.repeat(400), messages: [] };
    const meter = new ContextMeter();
    expect(meter.measure(request)).toBe(estimateRequest(request));

    meter.calibrate(request, estimateRequest(request) * 2);

    expect(meter.measure(request)).toBe(estimateRequest(request) * 2);
  });
});

describe('compaction', () => {
  it('clears long tool outputs except in the most recent turns', () => {
    const messages = [...history(6), ...exchange(9, 50)];

    const cleared = clearOldToolResults(messages);

    const outputs = cleared.flatMap((message) =>
      message.role === 'tool' ? message.content.map((part) => part.output) : [],
    );
    for (const output of outputs.slice(0, 3)) expect(output).toMatch(/^\[Output cleared/);
    expect(outputs.slice(3).map((output) => output.length)).toEqual([2_000, 2_000, 2_000, 50]);
    expect(messages[2]).toEqual(exchange(0)[1]);
  });

  it('stops at clearing tool outputs when that frees enough', async () => {
    const model = new ScriptedModelClient([], { capabilities: SMALL });

    const result = await compactHistory({
      messages: history(8),
      model,
      meter: new ContextMeter(),
      request: { system: '' },
      trigger: 'auto',
      target: 3_000,
      hooks: new HookRunner(),
      hookContext,
      signal: hookContext.signal,
    });

    expect(result).toMatchObject({ method: 'tool-results' });
    expect(result!.afterTokens).toBeLessThan(result!.beforeTokens);
    expect(model.requests).toHaveLength(0);
  });

  it('summarizes older turns, keeping recent ones whole and what hooks preserve', async () => {
    const model = new ScriptedModelClient([{ text: 'Goal: refactor. Read f0–f6.' }], {
      capabilities: SMALL,
    });
    const hooks = new HookRunner({ beforeCompact: () => ({ preserve: 'Never touch legacy/.' }) });

    const result = await compactHistory({
      messages: history(8),
      model,
      meter: new ContextMeter(),
      request: { system: '' },
      trigger: 'auto',
      target: 100,
      hooks,
      hookContext,
      signal: hookContext.signal,
    });

    expect(result?.method).toBe('summary');
    const [summary, ack, ...kept] = result!.messages;
    expect(textOf(summary!)).toMatch(new RegExp(`^${SUMMARY_PREFIX}`));
    expect(textOf(summary!)).toContain('<summary>\nGoal: refactor. Read f0–f6.\n</summary>');
    expect(textOf(summary!)).toContain('Kept as it was:\nNever touch legacy/.');
    expect(ack?.role).toBe('assistant');
    // The remainder never starts with results whose calls were summarized away.
    expect(kept[0]?.role).toBe('assistant');
    expect(kept.length).toBeGreaterThan(0);
    expect(textOf(model.requests[0]!.messages[0]!)).toContain('User: Refactor the parser.');
    expect(textOf(model.requests[0]!.messages[0]!)).toContain(
      'Assistant called read_file({"path":"f0"})',
    );
  });

  it('compacts by itself before a turn that would overflow, and the summary costs a call', async () => {
    const model = new ScriptedModelClient(
      [
        { text: 'Summary of the work so far.', usage: { inputTokens: 900, outputTokens: 50 } },
        { text: 'Continuing.', usage: { inputTokens: 300, outputTokens: 10 } },
      ],
      { capabilities: SMALL },
    );
    const session = new Session({ model, system: 'Be brief.', history: history(8, 3_000) });

    const events = await collect(session.send('Go on.'));

    const compaction = events.find((event) => event.type === 'compaction');
    expect(compaction).toMatchObject({ trigger: 'auto', method: 'summary' });
    expect(textOf(model.requests[1]!.messages[0]!)).toMatch(new RegExp(`^${SUMMARY_PREFIX}`));
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      stopReason: 'end_turn',
      usage: { inputTokens: 1_200, outputTokens: 60 },
    });
    expect(session.contextUsage().tokens).toBeLessThan(1_600);
  });

  it('compacts on request, keeping the task list, and a resumed session starts from there', async () => {
    const root = await tempDir();
    const store = new JsonlSessionStore(root);
    const todos = [
      { content: 'Parse headers', status: 'completed' },
      { content: 'Parse bodies', status: 'in_progress' },
    ];
    const model = new ScriptedModelClient(
      [
        { toolCalls: [{ name: 'todo_write', args: { todos } }] },
        { text: 'Working on bodies.' },
        ...Array.from({ length: 4 }, (_, index) => [
          { toolCalls: [{ name: 'todo_write', args: { todos } }], text: `step ${index}` },
        ]).flat(),
        { text: 'More.' },
        { text: 'The parser work: headers done, bodies next.' },
      ],
      { capabilities: { ...SMALL, contextWindow: 200_000 } },
    );
    const engine = await createEngine({
      model,
      toolsets: ['todo'],
      sessionStore: store,
      interactive: false,
    });
    const session = engine.session();
    // Long enough to be worth summarizing.
    await collect(session.send(`Write the parser. Spec: ${'x'.repeat(8_000)}`));
    await collect(session.send('Keep going.'));

    const report = await session.compact({ instructions: 'the parser' });
    await engine.dispose();

    expect(report).toMatchObject({ method: 'summary' });
    const summary = textOf(session.messages[0]!);
    expect(summary).toContain('The parser work: headers done, bodies next.');
    expect(summary).toContain(
      'Your task list (todo_write), as you last set it:\n[x] Parse headers\n[>] Parse bodies',
    );
    expect(textOf(model.requests.at(-1)!.messages[0]!)).toContain('Focus on: the parser');

    const restored = restoreSession(await store.load(session.id));
    expect(restored.messages).toEqual(session.messages);
  });

  it('replaces the history at a compaction record when restoring', () => {
    const before = userMessage('old');
    const summary = userMessage(`${SUMMARY_PREFIX}: …`);
    const after = userMessage('new');

    const restored = restoreSession([
      { type: 'message', timestamp: 0, message: before },
      { type: 'compaction', timestamp: 1, messages: [summary] },
      { type: 'message', timestamp: 2, message: after },
    ]);

    expect(restored.messages).toEqual([summary, after]);
  });

  it('can be switched off', async () => {
    const model = new ScriptedModelClient([{ text: 'ok' }], { capabilities: SMALL });
    const session = new Session({
      model,
      system: '',
      history: history(8, 3_000),
      compactAt: false,
    });

    const events: EngineEvent[] = await collect(session.send('Go on.'));

    expect(events.some((event) => event.type === 'compaction')).toBe(false);
    expect(model.requests).toHaveLength(1);
  });
});
