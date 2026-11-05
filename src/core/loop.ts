import { setTimeout as sleep } from 'node:timers/promises';
import { compactHistory, type ContextMeter, usableWindow } from './context.js';
import { isAbortError, ModelError, serializeError } from './errors.js';
import type { EngineEvent, EngineEventBody, StopReason } from './events.js';
import { type HookContext, type HookFailure, hookFailureEvent, type HookRunner } from './hooks.js';
import { type AssistantMessage, type Message, toolCallsOf, userMessage } from './messages.js';
import type { FinishReason, ModelClient, ModelRequest, ToolSpec } from './model.js';
import { executeToolCalls, type ToolRuntime } from './tool-execution.js';
import { addUsage, costOf, emptyUsage, type Usage } from './usage.js';

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/** A `beforeStop` check that fails the same way this often in a row ends the run. */
export const MAX_SAME_CHECK_FAILURES = 3;

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
  // The last check failure, to notice the agent going round in circles.
  let lastFailure: string | undefined;
  let sameFailures = 0;

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

      let request = buildRequest(options);
      if (yield* compactIfNeeded(request)) request = buildRequest(options);
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
        continue;
      }

      const results = yield* countingSubagents(
        executeToolCalls(toolCalls, options.tools, stamp, signal, remaining),
      );
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
 * A check's output without what changes on every run (timestamps, durations), so the same
 * failure looks the same. Counts stay: "4 tests failed" after "5 tests failed" is progress.
 */
export function failureKey(feedback: string): string {
  return feedback
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+(Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\b\d\d?:\d\d(:\d\d(\.\d+)?)?\b/g, '<time>')
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/g, '<duration>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2_000);
}

/** The request for the next turn. Tools are read per turn: MCP servers come and go. */
function buildRequest(options: LoopOptions): ModelRequest {
  const tools: ToolSpec[] = [...options.tools.tools().values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const effort = options.reasoningEffort?.();
  return {
    system: options.system(),
    messages: [...options.messages],
    ...(tools.length && { tools }),
    ...(effort && { reasoningEffort: effort }),
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
