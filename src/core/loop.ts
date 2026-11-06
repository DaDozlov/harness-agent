import { setTimeout as sleep } from 'node:timers/promises';
import { compactHistory, type ContextMeter, usableWindow } from './context.js';
import { isAbortError, ModelError, serializeError } from './errors.js';
import type { EngineEvent, EngineEventBody, StopReason } from './events.js';
import { type HookContext, type HookFailure, hookFailureEvent, type HookRunner } from './hooks.js';
import { type AssistantMessage, type Message, toolCallsOf, userMessage } from './messages.js';
import type { FinishReason, ModelClient, ModelRequest, ToolSpec } from './model.js';
import { failureKey } from './stuck.js';
import { executeToolCalls, type ToolRuntime } from './tool-execution.js';
import { forgetSeen } from './tools.js';
import { addUsage, costOf, emptyUsage, type Usage } from './usage.js';

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export { failureKey };

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/** A `beforeStop` check that fails the same way this often in a row ends the run. */
export const MAX_SAME_CHECK_FAILURES = 3;

/** The share of a limit after which the agent is asked to wrap up. */
export const NEAR_LIMIT = 0.8;

/** Limits per run, i.e. per user input (docs/DESIGN.md §4.1). */
export interface RunLimits {
  /** Model turns. */
  maxTurns: number;
  /** Tokens billed: input plus output, summed over the run's model calls. */
  maxTokens?: number | undefined;
  /** Cost in USD. Needs the model's prices. */
  maxCostUsd?: number | undefined;
  /** Wall-clock minutes, time spent waiting for approvals included. */
  maxMinutes?: number | undefined;
}

export interface LoopOptions {
  /** This agent's id, to tell its own events from its sub-agents'. */
  agentId: string;
  model: ModelClient;
  /** Read before each model turn, so it can change during a run (e.g. MCP servers connecting). */
  system: () => string;
  /** Conversation history. The loop appends the new user input and everything after it. */
  messages: Message[];
  input: string;
  limits: RunLimits;
  retry: RetryPolicy;
  tools: ToolRuntime;
  signal?: AbortSignal | undefined;
  /** Adds the session, agent and timestamp fields to an event. */
  stamp: (body: EngineEventBody) => EngineEvent;
  /** Called for every message the loop adds to the history, e.g. to save it. */
  onMessage?: ((message: Message) => void) | undefined;
  /** Called when compaction replaced the history, e.g. to save it. */
  onCompact?: ((messages: Message[]) => void) | undefined;
  hooks: HookRunner;
  hookContext: (signal: AbortSignal) => HookContext;
  meter: ContextMeter;
  /** Compact when a request would use more than this share of the usable window, or never. */
  compactAt: number | false;
  /** What the session is for, stamped on `run.start`. */
  intent?: string | undefined;
  /** Sent with every model call; read per call, so it can change between runs. */
  reasoningEffort?: (() => 'low' | 'medium' | 'high' | undefined) | undefined;
  /** Sent with every model call, see `ModelRequest.cacheKey`. */
  cacheKey?: string | undefined;
  /** Before the stop hooks: a reason to keep working, e.g. changes nothing has checked. */
  stopCheck?: (() => Promise<string | undefined> | string | undefined) | undefined;
  /** Events to add before `run.end`, e.g. links to the commits the run made. */
  beforeEnd?: (() => Promise<EngineEventBody[]>) | undefined;
}

export interface RunResult {
  stopReason: StopReason;
  usage: Usage;
  turns: number;
  /** Missing when the model's price is unknown. */
  costUsd?: number;
}

type CallOutcome =
  | { kind: 'finished'; message: AssistantMessage; finishReason: FinishReason; usage: Usage }
  | { kind: 'aborted'; partialText: string };

/** Runs one user input to completion: model call, tool calls, repeat (docs/DESIGN.md §4.1). */
export async function* runLoop(options: LoopOptions): AsyncGenerator<EngineEvent, RunResult> {
  const { stamp, limits, hooks, model } = options;
  const addMessage = (message: Message) => {
    options.messages.push(message);
    options.onMessage?.(message);
  };
  // The time limit aborts like an interruption, so running tools and approvals stop too.
  const deadline = limits.maxMinutes ? AbortSignal.timeout(limits.maxMinutes * 60_000) : undefined;
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    ...(deadline ? [deadline] : []),
  ]);
  const abortReason = (): StopReason => (deadline?.aborted ? 'time_limit' : 'aborted');
  const hookContext = options.hookContext(signal);
  let usage = emptyUsage();
  let costUsd: number | undefined;
  let turns = 0;
  const startedAt = Date.now();
  // The last check failure, to notice the agent going round in circles.
  let lastFailure: string | undefined;
  let sameFailures = 0;
  // Whether the agent was told that the run is near a limit.
  let warned = false;
  // The next model call thinks harder: a check failed, or the agent is going in circles.
  let thinkHarder = false;

  function* account(callUsage: Usage): Generator<EngineEvent> {
    usage = addUsage(usage, callUsage);
    const callCost = costOf(callUsage, model.capabilities.pricing);
    if (callCost !== undefined) costUsd = (costUsd ?? 0) + callCost;
    yield stamp({
      type: 'usage',
      usage: callUsage,
      model: model.id,
      ...(callCost !== undefined && { costUsd: callCost }),
    });
  }
  function* reported(failures: HookFailure[]): Generator<EngineEvent> {
    for (const failure of failures) yield stamp(hookFailureEvent(failure));
  }
  /** What sub-agents may still spend: a run's budget includes its sub-agents. */
  const remaining = () => ({
    ...(limits.maxTokens !== undefined && {
      tokens: Math.max(0, limits.maxTokens - usage.inputTokens - usage.outputTokens),
    }),
    ...(limits.maxCostUsd !== undefined && {
      costUsd: Math.max(0, limits.maxCostUsd - (costUsd ?? 0)),
    }),
  });
  /** Passes events on, counting every sub-agent model call into this run (each reports once). */
  async function* countingSubagents<T>(
    events: AsyncGenerator<EngineEvent, T>,
  ): AsyncGenerator<EngineEvent, T> {
    for (;;) {
      const step = await events.next();
      if (step.done) return step.value;
      const event = step.value;
      if (event.type === 'usage' && event.agentId !== options.agentId) {
        usage = addUsage(usage, event.usage);
        if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
      }
      if (event.type === 'stuck' && event.agentId === options.agentId) thinkHarder = true;
      yield event;
    }
  }

  const threshold =
    options.compactAt === false ? Infinity : options.compactAt * usableWindow(model.capabilities);
  // Set when compaction could not get below the threshold, so it is not retried every turn.
  let stuckAt: number | undefined;

  async function* compactIfNeeded(request: ModelRequest): AsyncGenerator<EngineEvent, boolean> {
    if (options.messages.length === stuckAt || options.meter.measure(request) <= threshold) {
      return false;
    }
    try {
      const result = await compactHistory({
        messages: options.messages,
        model,
        meter: options.meter,
        request: { system: request.system, ...(request.tools && { tools: request.tools }) },
        trigger: 'auto',
        // Clearing tool results is only worth it with room to spare.
        target: threshold * 0.75,
        hooks,
        hookContext,
        signal,
      });
      if (!result) {
        stuckAt = options.messages.length;
        return false;
      }
      options.messages.splice(0, options.messages.length, ...result.messages);
      forgetSeen(options.tools.state);
      options.onCompact?.(options.messages);
      if (result.afterTokens > threshold) stuckAt = options.messages.length;
      yield stamp({
        type: 'compaction',
        trigger: 'auto',
        method: result.method,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
      yield* reported(result.failures);
      if (result.method === 'summary') yield* account(result.usage);
      return true;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      stuckAt = options.messages.length;
      const message = error instanceof Error ? error.message : String(error);
      yield stamp({
        type: 'error',
        error: {
          name: 'CompactionError',
          message: `Could not compact the conversation: ${message}`,
        },
        recoverable: true,
      });
      return false;
    }
  }

  async function* run(): AsyncGenerator<EngineEvent, StopReason> {
    if (limits.maxCostUsd !== undefined && !model.capabilities.pricing) {
      throw new Error(unknownPriceMessage(model.id));
    }
    const prompt = await hooks.userPrompt(hookContext, options.input);
    yield* reported(prompt.failures);
    if (prompt.block !== undefined) {
      yield stamp({ type: 'hook', hook: 'userPrompt', message: prompt.block });
      return 'blocked';
    }
    addMessage({
      role: 'user',
      content: [
        { type: 'text', text: prompt.prompt },
        ...(prompt.context ? [{ type: 'text' as const, text: prompt.context }] : []),
      ],
    });

    while (true) {
      if (signal.aborted) return abortReason();
      const limit = limitReached(limits, turns, usage, costUsd);
      if (limit) return limit;
      turns++;
      yield stamp({ type: 'turn.start', turn: turns });

      // Finding why something fails is where more reasoning pays off, more than writing code.
      const effort = thinkHarder && model.capabilities.reasoning ? 'high' : undefined;
      thinkHarder = false;
      let request = buildRequest(options, effort);
      if (yield* compactIfNeeded(request)) request = buildRequest(options, effort);
      const adjusted = await hooks.beforeModelCall(hookContext, request, turns);
      yield* reported(adjusted.failures);
      request = adjusted.request;

      const outcome = yield* callModel(request, options, signal);
      if (outcome.kind === 'aborted') {
        if (outcome.partialText) {
          addMessage({ role: 'assistant', content: [{ type: 'text', text: outcome.partialText }] });
        }
        return abortReason();
      }

      options.meter.calibrate(request, outcome.usage.inputTokens);
      addMessage(outcome.message);
      yield stamp({ type: 'message.complete', message: outcome.message });
      yield* account(outcome.usage);
      const after = await hooks.afterModelCall(hookContext, outcome.message, outcome.usage, turns);
      yield* reported(after.failures);

      const toolCalls = toolCallsOf(outcome.message);
      if (toolCalls.length === 0) {
        const reason = stopReasonFor(outcome.finishReason);
        if (reason !== 'end_turn') return reason;
        // Verification point: a hook can send the agent back to work.
        const reminder = await options.stopCheck?.();
        if (reminder) {
          yield stamp({ type: 'hook', hook: 'beforeStop', message: reminder, builtIn: true });
          addMessage(userMessage(reminder));
          continue;
        }
        const edited = options.tools.changes?.edited ?? [];
        const verdict = await hooks.beforeStop(hookContext, outcome.message, turns, edited);
        yield* reported(verdict.failures);
        if (!verdict.feedback) return 'end_turn';
        yield stamp({ type: 'hook', hook: 'beforeStop', message: verdict.feedback });
        const failure = failureKey(verdict.feedback);
        sameFailures = failure === lastFailure ? sameFailures + 1 : 1;
        lastFailure = failure;
        // Stuck, or the check cannot run here (a missing tool): only a person can help now.
        if (sameFailures >= MAX_SAME_CHECK_FAILURES) return 'check_failed';
        addMessage(userMessage(`A check before finishing reported:\n\n${verdict.feedback}`));
        thinkHarder = true;
        continue;
      }

      const results = yield* countingSubagents(
        executeToolCalls(toolCalls, options.tools, stamp, signal, remaining),
      );
      // Once per run, near a limit: ask the agent to wrap up while it still can. Added to the
      // last result, which every provider accepts after tool calls.
      const minutes = (Date.now() - startedAt) / 60_000;
      const near = warned ? undefined : nearLimit(limits, { turns, usage, costUsd, minutes });
      if (near) {
        warned = true;
        yield stamp({ type: 'limit.near', ...near });
        const last = results.at(-1);
        if (last) last.output += `\n\n[${nearLimitNote(near)}]`;
      }
      addMessage({ role: 'tool', content: results });
    }
  }

  yield stamp({
    type: 'run.start',
    input: options.input,
    ...(options.intent && { intent: options.intent }),
  });
  let stopReason: StopReason;
  try {
    stopReason = yield* run();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      stopReason = abortReason();
    } else {
      stopReason = 'error';
      yield stamp({ type: 'error', error: serializeError(error), recoverable: false });
    }
  }

  for (const body of (await options.beforeEnd?.().catch(() => [])) ?? []) yield stamp(body);
  const cost = costUsd === undefined ? {} : { costUsd };
  yield stamp({ type: 'run.end', stopReason, usage, turns, ...cost });
  return { stopReason, usage, turns, ...cost };
}

/**
 * The request for the next turn. Tools are read per turn: MCP servers come and go. `effort`
 * overrides the session's reasoning effort for this one call.
 */
function buildRequest(options: LoopOptions, effort = options.reasoningEffort?.()): ModelRequest {
  const tools: ToolSpec[] = [...options.tools.tools().values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return {
    system: options.system(),
    messages: [...options.messages],
    ...(tools.length && { tools }),
    ...(effort && { reasoningEffort: effort }),
    ...(options.cacheKey && { cacheKey: options.cacheKey }),
  };
}

function limitReached(
  limits: RunLimits,
  turns: number,
  usage: Usage,
  costUsd: number | undefined,
): StopReason | undefined {
  if (turns >= limits.maxTurns) return 'max_turns';
  if (
    limits.maxTokens !== undefined &&
    usage.inputTokens + usage.outputTokens >= limits.maxTokens
  ) {
    return 'token_limit';
  }
  if (limits.maxCostUsd !== undefined && (costUsd ?? 0) >= limits.maxCostUsd) return 'cost_limit';
  return undefined;
}

export type NearLimit = {
  limit: 'turns' | 'tokens' | 'cost' | 'time';
  used: number;
  max: number;
};

/** What a run has used so far; `minutes` of wall-clock time. */
export interface RunSpent {
  turns: number;
  usage: Usage;
  costUsd: number | undefined;
  minutes: number;
}

/** The limit the run has used the most of, once that is past `NEAR_LIMIT`. */
export function nearLimit(limits: RunLimits, spent: RunSpent): NearLimit | undefined {
  const candidates: NearLimit[] = [
    { limit: 'turns', used: spent.turns, max: limits.maxTurns },
    ...(limits.maxTokens !== undefined
      ? [
          {
            limit: 'tokens' as const,
            used: spent.usage.inputTokens + spent.usage.outputTokens,
            max: limits.maxTokens,
          },
        ]
      : []),
    ...(limits.maxCostUsd !== undefined
      ? [{ limit: 'cost' as const, used: spent.costUsd ?? 0, max: limits.maxCostUsd }]
      : []),
    ...(limits.maxMinutes !== undefined
      ? [{ limit: 'time' as const, used: spent.minutes, max: limits.maxMinutes }]
      : []),
  ];
  const [most] = candidates
    .filter((candidate) => candidate.max > 0 && candidate.used / candidate.max >= NEAR_LIMIT)
    .sort((a, b) => b.used / b.max - a.used / a.max);
  return most;
}

/** How much of a limit was used, e.g. `$4.10 of $5.00` or `41 of 50 minutes`. */
export function nearLimitAmount({ limit, used, max }: NearLimit): string {
  if (limit === 'cost') return `$${used.toFixed(2)} of $${max.toFixed(2)}`;
  if (limit === 'time') return `${Math.floor(used)} of ${max} minutes`;
  return `${used.toLocaleString('en-US')} of ${max.toLocaleString('en-US')} ${limit}`;
}

/** What the agent is told when the run is near a limit. */
export function nearLimitNote(near: NearLimit): string {
  return (
    `heaw: this message has used ${Math.round((100 * near.used) / near.max)}% of its ${near.limit} limit ` +
    `(${nearLimitAmount(near)}). Finish what you are doing in as few steps as you can, start ` +
    'nothing big (no new sub-agents), then stop and report what is done and what is left; the ' +
    'user can continue in a new message.'
  );
}

/** A cost limit that cannot be checked would silently never stop anything. */
export function unknownPriceMessage(modelId: string): string {
  return (
    `A cost limit is set, but the price of ${modelId} is unknown, so it cannot be checked. ` +
    `Set the price in heaw.config.ts: models: { '${modelId}': { pricing: { input: 2.5, ` +
    'output: 15 } } } (USD per million tokens), or remove the cost limit.'
  );
}

/**
 * One model call, streamed. Retryable errors are retried only while nothing has been streamed
 * yet; after that a retry would repeat output the user has already seen.
 */
async function* callModel(
  request: ModelRequest,
  options: LoopOptions,
  signal: AbortSignal,
): AsyncGenerator<EngineEvent, CallOutcome> {
  const { model, stamp, retry } = options;

  for (let attempt = 0; ; attempt++) {
    let partialText = '';
    let streamed = false;
    try {
      for await (const event of model.stream(request, signal)) {
        switch (event.type) {
          case 'text-delta':
            streamed = true;
            partialText += event.text;
            yield stamp({ type: 'text.delta', text: event.text });
            break;
          case 'reasoning-delta':
            streamed = true;
            yield stamp({ type: 'reasoning.delta', text: event.text });
            break;
          case 'finish':
            return {
              kind: 'finished',
              message: event.message,
              finishReason: event.finishReason,
              usage: event.usage,
            };
        }
      }
      throw new ModelError('The model stream ended without a finish event.', { retryable: true });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return { kind: 'aborted', partialText };
      const canRetry =
        error instanceof ModelError && error.retryable && !streamed && attempt < retry.maxRetries;
      if (!canRetry) throw error;
      yield stamp({ type: 'error', error: serializeError(error), recoverable: true });
      await sleep(retryDelay(error, attempt, retry), undefined, { signal });
    }
  }
}

function retryDelay(error: ModelError, attempt: number, policy: RetryPolicy): number {
  const backoff = policy.initialDelayMs * 2 ** attempt;
  return Math.min(error.retryAfterMs ?? backoff, policy.maxDelayMs);
}

function stopReasonFor(finishReason: FinishReason): StopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'content-filter':
      return 'content_filter';
    default:
      return 'end_turn';
  }
}
