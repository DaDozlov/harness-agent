import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeConfigs } from '../../src/config/load.js';
import type { EngineEvent } from '../../src/core/events.js';
import type { Hooks } from '../../src/core/hooks.js';
import { textOf } from '../../src/core/messages.js';
import type { ModelCapabilities } from '../../src/core/model.js';
import { Session, type SessionOptions } from '../../src/core/session.js';
import { restoreSession } from '../../src/core/session-store.js';
import { costOf, emptyUsage } from '../../src/core/usage.js';
import { createEngine } from '../../src/engine.js';
import { capabilitiesFor, pricingFor } from '../../src/providers/catalog.js';
import { ProviderConfigError } from '../../src/providers/registry.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { defineTool } from '../../src/tools/define.js';
import { collect, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const PRICED: Partial<ModelCapabilities> = { pricing: { input: 10, output: 20 } };

/** A tool that echoes its text, so tests can see the arguments it got. */
const echo = defineTool({
  name: 'echo',
  description: 'Echo text',
  kind: 'execute',
  parameters: z.object({ text: z.string() }),
  subject: (args) => args.text,
  run: ({ text }) => `echo: ${text}`,
});

async function setup(
  responses: ScriptedResponse[],
  options: Partial<SessionOptions> & { capabilities?: Partial<ModelCapabilities> } = {},
) {
  const { capabilities, ...rest } = options;
  const model = new ScriptedModelClient(responses, { ...(capabilities && { capabilities }) });
  const session = new Session({
    model,
    system: 'Be brief.',
    workspace: await tempWorkspace(),
    tools: [echo],
    interactive: false,
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    ...rest,
  });
  return { model, session };
}

const runEnd = (events: EngineEvent[]) => events.find((event) => event.type === 'run.end')!;
const ofType = <T extends EngineEvent['type']>(events: EngineEvent[], type: T) =>
  events.filter((event): event is Extract<EngineEvent, { type: T }> => event.type === type);
const callEcho = (
  text: string,
  usage = { inputTokens: 600, outputTokens: 0 },
): ScriptedResponse => ({
  toolCalls: [{ name: 'echo', args: { text } }],
  usage,
});

describe('near a limit', () => {
  it('asks the agent once to wrap up when the run has used 80% of a limit', async () => {
    const { model, session } = await setup(
      [
        callEcho('1'),
        callEcho('2'),
        callEcho('3'),
        callEcho('4'),
        { text: 'Steps 1-4 are done; step 5 is left.' },
      ],
      { limits: { maxTurns: 5 } },
    );

    const events = await collect(session.send('go'));

    expect(ofType(events, 'limit.near')).toMatchObject([{ limit: 'turns', used: 4, max: 5 }]);
    expect(JSON.stringify(model.requests[3]?.messages.at(-1))).not.toContain('heaw:');
    expect(JSON.stringify(model.requests[4]?.messages.at(-1))).toContain(
      'heaw: this message has used 80% of its turns limit (4 of 5 turns). Finish what you are doing',
    );
    // It could still finish on its own instead of being cut off.
    expect(runEnd(events)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('counts the cost too', async () => {
    const { model, session } = await setup(
      [callEcho('1', { inputTokens: 85_000, outputTokens: 0 }), { text: 'done' }],
      { limits: { maxTurns: 50, maxCostUsd: 1 }, capabilities: PRICED },
    );

    const events = await collect(session.send('go'));

    expect(ofType(events, 'limit.near')).toMatchObject([{ limit: 'cost', used: 0.85, max: 1 }]);
    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).toContain(
      'its cost limit ($0.85 of $1.00)',
    );
  });
});

describe('usage and cost', () => {
  it('prices usage, with cached input at its own price', () => {
    const usage = {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      cacheReadTokens: 400_000,
      outputTokens: 100_000,
    };
    expect(costOf(usage, { input: 2.5, cacheRead: 0.25, output: 15 })).toBeCloseTo(3.1);
    expect(costOf(usage, { input: 2.5, output: 15 })).toBeCloseTo(4);
    expect(costOf(usage, undefined)).toBeUndefined();
  });

  it('knows prices only for exact models, so a family never lends its price', () => {
    expect(pricingFor('gpt-5.4')).toEqual({ input: 2.5, cacheRead: 0.25, output: 15 });
    expect(pricingFor('gpt-5-2025-08-07')).toEqual(pricingFor('gpt-5'));
    expect(pricingFor('gpt-5.4-pro')).toBeUndefined();
    expect(capabilitiesFor('gpt-5.4')).toMatchObject({
      contextWindow: 400_000,
      pricing: { output: 15 },
    });
    expect(capabilitiesFor('my-deployment').pricing).toBeUndefined();
  });

  it('reports the cost of each call, each run and the session', async () => {
    const { session } = await setup(
      [
        { text: 'one', usage: { inputTokens: 1_000, outputTokens: 500 } },
        { text: 'two', usage: { inputTokens: 2_000, outputTokens: 0 } },
      ],
      { capabilities: PRICED },
    );

    const first = await collect(session.send('a'));
    await collect(session.send('b'));

    expect(ofType(first, 'usage')[0]?.costUsd).toBeCloseTo(0.02);
    expect(runEnd(first)).toMatchObject({ costUsd: expect.closeTo(0.02) as unknown });
    expect(session.costUsd).toBeCloseTo(0.04);
  });

  it('leaves the cost out when the price is unknown', async () => {
    const { session } = await setup([{ text: 'hi', usage: { inputTokens: 10 } }]);

    const events = await collect(session.send('a'));

    expect(ofType(events, 'usage')[0]).not.toHaveProperty('costUsd');
    expect(runEnd(events)).not.toHaveProperty('costUsd');
    expect(session.costUsd).toBeUndefined();
  });

  it('restores usage and cost from the log, including calls outside runs', () => {
    const base = { sessionId: 's', agentId: 'main', timestamp: 0 };
    const usage = (inputTokens: number, costUsd?: number) => ({
      type: 'event' as const,
      event: {
        ...base,
        type: 'usage' as const,
        usage: { ...emptyUsage(), inputTokens },
        ...(costUsd !== undefined && { costUsd }),
      },
    });

    const restored = restoreSession([usage(100, 0.5), usage(50, 0.25), usage(10)]);

    expect(restored.usage.inputTokens).toBe(160);
    expect(restored.costUsd).toBeCloseTo(0.75);
  });
});

describe('run limits', () => {
  it('asks for a report without tools when the turn limit stops the agent mid-work', async () => {
    const { model, session } = await setup(
      [
        callEcho('1'),
        callEcho('2'),
        // A provider that ignores the tool choice still calls one: dropped, nothing would answer.
        {
          text: 'Did 1 and 2; 3 is left.',
          toolCalls: [{ name: 'echo', args: { text: '3' } }],
        },
      ],
      { limits: { maxTurns: 2 } },
    );

    const events = await collect(session.send('go'));

    expect(model.requests).toHaveLength(3);
    const report = model.requests[2]!;
    expect(report.toolChoice).toBe('none');
    expect(report.tools?.length).toBeGreaterThan(0);
    expect(textOf(report.messages.at(-1)!)).toContain(
      '[heaw: this message has reached its limit of 2 turns, so no more tools can be called.',
    );
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Did 1 and 2; 3 is left.' }],
    });
    expect(session.messages.at(-1)?.content).toHaveLength(1);
    expect(ofType(events, 'tool.start')).toHaveLength(2);
    expect(runEnd(events)).toMatchObject({ stopReason: 'max_turns', turns: 2 });
  });

  it('stops at the token limit', async () => {
    const { session } = await setup([callEcho('1'), callEcho('2'), callEcho('3')], {
      limits: { maxTokens: 1_000 },
    });

    const events = await collect(session.send('go'));

    expect(runEnd(events)).toMatchObject({ stopReason: 'token_limit', turns: 2 });
  });

  it('stops at the cost limit', async () => {
    const { session } = await setup(
      [callEcho('1', { inputTokens: 1_000, outputTokens: 0 }), callEcho('2')],
      { capabilities: PRICED, limits: { maxCostUsd: 0.01 } },
    );

    const events = await collect(session.send('go'));

    expect(runEnd(events)).toMatchObject({ stopReason: 'cost_limit', turns: 1 });
  });

  it('refuses a cost limit it cannot check, in a run and when the engine starts', async () => {
    const { session, model } = await setup([{ text: 'never' }], { limits: { maxCostUsd: 1 } });

    const events = await collect(session.send('go'));

    expect(runEnd(events).stopReason).toBe('error');
    expect(ofType(events, 'error')[0]?.error.message).toContain(
      "the price of scripted:test is unknown, so it cannot be checked. Set the price in heaw.config.ts: models: { 'scripted:test': { pricing:",
    );
    expect(model.requests).toHaveLength(0);
    await expect(
      createEngine({ model: new ScriptedModelClient([]), limits: { maxCostUsd: 1 } }),
    ).rejects.toThrow(ProviderConfigError);
  });

  it('stops at the time limit, mid-answer', async () => {
    const { session } = await setup([{ text: 'x'.repeat(400), chunkSize: 1, chunkDelayMs: 20 }], {
      limits: { maxMinutes: 0.003 },
    });

    const events = await collect(session.send('go'));

    expect(runEnd(events).stopReason).toBe('time_limit');
  });
});

describe('hooks', () => {
  it('lets userPrompt rewrite a prompt and add context, or block it', async () => {
    const rewrite: Hooks = {
      userPrompt: ({ prompt }) => ({ prompt: prompt.toUpperCase(), context: 'Ticket: PROJ-1' }),
    };
    const { model, session } = await setup([{ text: 'ok' }], { hooks: rewrite });
    await collect(session.send('fix it'));
    expect(model.requests[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'FIX IT' },
      { type: 'text', text: 'Ticket: PROJ-1' },
    ]);

    const block: Hooks = { userPrompt: () => ({ block: 'No deploys on Fridays.' }) };
    const blocked = await setup([{ text: 'never' }], { hooks: block });
    const events = await collect(blocked.session.send('deploy'));
    expect(runEnd(events).stopReason).toBe('blocked');
    expect(ofType(events, 'hook')).toMatchObject([
      { hook: 'userPrompt', message: 'No deploys on Fridays.' },
    ]);
    expect(blocked.model.requests).toHaveLength(0);
    expect(blocked.session.messages).toEqual([]);
  });

  it('runs sessionStart once, adding its context to the system prompt', async () => {
    const calls: boolean[] = [];
    const hooks: Hooks = {
      sessionStart: ({ resumed }) => {
        calls.push(resumed);
        return { context: 'Current branch: feature/x' };
      },
    };
    const { model, session } = await setup([{ text: 'a' }, { text: 'b' }], { hooks });

    await collect(session.send('one'));
    await collect(session.send('two'));

    expect(calls).toEqual([false]);
    expect(model.requests[1]?.system).toBe('Be brief.\n\nCurrent branch: feature/x');
  });

  it('lets model call hooks change the request and see the answer', async () => {
    const seen: string[] = [];
    const hooks: Hooks = {
      beforeModelCall: ({ request }) => ({ request: { ...request, temperature: 0 } }),
      afterModelCall: ({ message, turn }) => {
        seen.push(`${turn}: ${textOf(message)}`);
      },
    };
    const { model, session } = await setup([{ text: 'hello' }], { hooks });

    await collect(session.send('hi'));

    expect(model.requests[0]?.temperature).toBe(0);
    expect(seen).toEqual(['1: hello']);
  });

  it('lets beforeToolCall block, rewrite or allow calls, but not override deny rules', async () => {
    const hooks: Hooks = {
      beforeToolCall: ({ args }) => {
        const { text } = args as { text: string };
        if (text === 'rm') return { block: 'not here' };
        if (text === 'crash') throw new Error('guard broke');
        return { args: { text: `${text}!` }, allow: true };
      },
    };
    const { session } = await setup(
      [
        {
          toolCalls: [
            { name: 'echo', args: { text: 'hi' } },
            { name: 'echo', args: { text: 'rm' } },
            { name: 'echo', args: { text: 'crash' } },
            { name: 'echo', args: { text: 'secret' } },
          ],
        },
        { text: 'done' },
      ],
      { hooks, permissions: { deny: ['echo(secret!)'] } },
    );

    const events = await collect(session.send('go'));

    // Denials are reported as soon as they are decided, before allowed calls run.
    expect(ofType(events, 'tool.end').map((event) => [event.status, event.output])).toEqual([
      ['denied', 'Blocked by a hook: not here'],
      ['denied', 'Blocked by a hook: the beforeToolCall hook failed: guard broke'],
      ['denied', 'Permission denied: it matches the deny rule "echo(secret!)".'],
      ['ok', 'echo: hi!'],
    ]);
  });

  it('lets afterToolCall add feedback, and reports a failing hook without stopping', async () => {
    const hooks: Hooks[] = [
      {
        afterToolCall: ({ output }) => ({ feedback: `Lint: 0 problems (${output.length} chars)` }),
      },
      {
        afterModelCall: () => {
          throw new Error('logger down');
        },
      },
    ];
    const { session } = await setup([callEcho('a'), { text: 'done' }], {
      hooks,
      permissions: { allow: ['echo'] },
    });

    const events = await collect(session.send('go'));

    expect(ofType(events, 'tool.end')[0]?.output).toBe('echo: a\n\nLint: 0 problems (7 chars)');
    expect(
      ofType(events, 'error').map((event) => [event.recoverable, event.error.message]),
    ).toEqual([
      [true, 'The afterModelCall hook failed: logger down'],
      [true, 'The afterModelCall hook failed: logger down'],
    ]);
    expect(runEnd(events).stopReason).toBe('end_turn');
  });

  it('lets beforeStop send the agent back to work until the check passes', async () => {
    let checks = 0;
    const hooks: Hooks = {
      beforeStop: () =>
        ++checks === 1 ? { continue: true, feedback: 'Tests fail: 1 failing' } : undefined,
    };
    const { model, session } = await setup([{ text: 'Done!' }, { text: 'Fixed, tests pass.' }], {
      hooks,
    });

    const events = await collect(session.send('fix'));

    expect(checks).toBe(2);
    expect(ofType(events, 'hook')).toMatchObject([
      { hook: 'beforeStop', message: 'Tests fail: 1 failing' },
    ]);
    expect(textOf(model.requests[1]!.messages.at(-1)!)).toBe(
      'A check before finishing reported:\n\nTests fail: 1 failing',
    );
    expect(runEnd(events)).toMatchObject({ stopReason: 'end_turn', turns: 2 });
  });

  it('stops waiting for a hook that ignores the signal when the run is interrupted', async () => {
    const controller = new AbortController();
    const hooks: Hooks = {
      // Like tests run without the signal: Esc during the check.
      beforeStop: () => {
        controller.abort();
        return new Promise<undefined>(() => {});
      },
    };
    const { session } = await setup([{ text: 'Done!' }], { hooks });

    const events = await collect(session.send('fix', { signal: controller.signal }));

    expect(runEnd(events)).toMatchObject({ stopReason: 'aborted', turns: 1 });
    // The session can go on.
    expect(session.running).toBe(false);
  });

  it('runs sessionEnd on close, only for a session that ran', async () => {
    const ended: number[] = [];
    const hooks: Hooks = {
      sessionEnd: ({ usage }) => {
        ended.push(usage.inputTokens);
      },
    };
    const idle = await setup([], { hooks });
    await idle.session.close();
    const used = await setup([{ text: 'hi', usage: { inputTokens: 42 } }], { hooks });
    await collect(used.session.send('hi'));
    await used.session.close();
    await used.session.close();

    expect(ended).toEqual([42]);
  });

  it('combines personal and project hooks from config, personal first', () => {
    const personal: Hooks = { beforeStop: () => undefined };
    const project: Hooks = { afterToolCall: () => undefined };

    expect(mergeConfigs({ hooks: personal }, { hooks: project }).hooks).toEqual([
      personal,
      project,
    ]);
  });
});
