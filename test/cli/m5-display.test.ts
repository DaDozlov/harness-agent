import { describe, expect, it } from 'vitest';
import { runSlashCommand } from '../../src/cli/chat/commands.js';
import {
  createTranscript,
  itemsFromHistory,
  transcriptReducer,
} from '../../src/cli/chat/transcript.js';
import { runPrompt } from '../../src/cli/commands/run.js';
import { SUMMARY_PREFIX } from '../../src/core/context.js';
import type { EngineEventBody } from '../../src/core/events.js';
import { userMessage } from '../../src/core/messages.js';
import { emptyUsage } from '../../src/core/usage.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';

const PRICED = { pricing: { input: 10, output: 20 } };

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

function shown(...bodies: EngineEventBody[]) {
  let state = createTranscript(emptyUsage());
  for (const body of bodies) {
    state = transcriptReducer(state, {
      type: 'event',
      event: { ...body, sessionId: 's', agentId: 'main', timestamp: 0 },
    });
  }
  return state;
}

describe('the chat shows M5 activity', () => {
  it('turns compactions, hooks and their errors into notices, and adds up the cost', () => {
    const state = shown(
      { type: 'usage', usage: emptyUsage(), costUsd: 0.25 },
      { type: 'usage', usage: emptyUsage(), costUsd: 0.5 },
      {
        type: 'compaction',
        trigger: 'auto',
        method: 'summary',
        beforeTokens: 180_000,
        afterTokens: 24_000,
      },
      { type: 'hook', hook: 'beforeStop', message: '\nTests fail:\n1 failing' },
      {
        type: 'error',
        error: { name: 'HookError', message: 'The afterToolCall hook failed: x' },
        recoverable: true,
      },
      { type: 'run.end', stopReason: 'cost_limit', usage: emptyUsage(), turns: 3 },
    );

    expect(state.costUsd).toBeCloseTo(0.75);
    expect(state.items.map((item) => (item.kind === 'notice' ? item.text : item.kind))).toEqual([
      'Context compacted to fit the window: 180k → 24k tokens, older turns summarized.',
      'A check before finishing failed, so the agent keeps working: Tests fail:',
      'The afterToolCall hook failed: x',
      'Stopped: this message reached its cost limit.',
    ]);
  });

  it('shows a summary as a note when a compacted session is resumed', () => {
    const items = itemsFromHistory([
      userMessage(`${SUMMARY_PREFIX} to fit the context window.\n\n<summary>…</summary>`),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood. I will continue from here.' }],
      },
      userMessage('Next step?'),
    ]);

    expect(items).toMatchObject([
      { kind: 'notice', text: 'Earlier turns were summarized.' },
      { kind: 'user', text: 'Next step?' },
    ]);
  });

  it('/cost shows cost and context, /compact summarizes', async () => {
    const model = new ScriptedModelClient(
      [
        { text: 'First answer.', usage: { inputTokens: 1_000, outputTokens: 100 } },
        { text: 'Second answer.', usage: { inputTokens: 1_000, outputTokens: 100 } },
        { text: 'Summary.', usage: { inputTokens: 500, outputTokens: 50 } },
      ],
      { capabilities: PRICED },
    );
    const engine = await createEngine({ model, toolsets: [] });
    const session = engine.session();
    for await (const _event of session.send(`One: ${'x'.repeat(8_000)}`)) void _event;
    for await (const _event of session.send('Two')) void _event;
    const printed: string[] = [];
    const ctx = {
      engine,
      session: () => session,
      print: (text: string) => printed.push(text),
      newSession: () => undefined,
      refresh: () => undefined,
      exit: () => undefined,
    };

    await runSlashCommand('/cost', ctx);
    await runSlashCommand('/compact the answers', ctx);
    // What is left is too short to summarize again.
    await runSlashCommand('/compact', ctx);
    await engine.dispose();

    expect(printed[0]).toContain('Cost: $0.0240.');
    expect(printed[0]).toMatch(/Context: about [\d.]+k? of 112k tokens \(\d+%\)/);
    expect(printed[2]).toMatch(
      /^Compacted: [\d.]+k? → [\d.]+k? tokens \(the summary cost \$0\.0060\)\./,
    );
    expect(printed.at(-1)).toBe('Nothing to compact yet: the conversation is still short.');
    expect(session.costUsd).toBeCloseTo(0.03);
  });

  it('/cost explains how to set an unknown price', async () => {
    const engine = await createEngine({ model: new ScriptedModelClient([]), toolsets: [] });
    const printed: string[] = [];

    await runSlashCommand('/cost', {
      engine,
      session: () => engine.session(),
      print: (text: string) => printed.push(text),
      newSession: () => undefined,
      refresh: () => undefined,
      exit: () => undefined,
    });

    expect(printed[0]).toContain(
      "Cost unknown: heaw has no price for scripted:test. Set it in heaw.config.ts with models: { 'scripted:test': { pricing:",
    );
  });
});

describe('heaw run shows M5 activity', () => {
  it('adds the cost to the summary and explains limit stops', async () => {
    const model = new ScriptedModelClient(
      [{ toolCalls: [{ name: 'todo_write', args: { todos: [] } }], usage: { inputTokens: 2_000 } }],
      { capabilities: PRICED },
    );
    const engine = await createEngine({ model, toolsets: ['todo'], limits: { maxCostUsd: 0.01 } });
    const stdout = output();
    const stderr = output();

    const code = await runPrompt(engine, 'Plan it', {}, { stdout, stderr });
    await engine.dispose();

    expect(code).toBe(1);
    expect(stderr.text).toContain(
      'Stopped: reached the cost limit (--max-cost or limits.maxCostUsd).\nscripted:test · 1 turn · 2000 in / 0 out tokens · $0.0200',
    );
  });

  it('runs sessionEnd hooks after the run and reports failures', async () => {
    const engine = await createEngine({
      model: new ScriptedModelClient([{ text: 'ok' }]),
      toolsets: [],
      hooks: {
        sessionEnd: () => {
          throw new Error('report upload failed');
        },
      },
    });
    const stderr = output();

    await runPrompt(engine, 'Hi', {}, { stdout: output(), stderr });
    await engine.dispose();

    expect(stderr.text).toContain('The sessionEnd hook failed: report upload failed');
  });
});
