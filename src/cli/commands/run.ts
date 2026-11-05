import { text } from 'node:stream/consumers';
import type { EngineEvent, StopReason } from '../../core/events.js';
import { createEngine, type Engine } from '../../engine.js';
import type { Env } from '../../providers/registry.js';
import { failureSummary, formatCost, toolLabel } from '../format.js';
import { type AgentFlags, setupEngine, userFacingMessage } from '../setup.js';

export interface Output {
  write(chunk: string): unknown;
}

export interface RunContext {
  cwd: string;
  env: Env;
  /** See `LoadConfigOptions.packageEntry`. */
  packageEntry?: string | undefined;
  stdout: Output;
  stderr: Output;
  /** Returns piped input, or undefined when stdin is an interactive terminal. */
  readStdin: () => Promise<string | undefined>;
  createEngine: typeof createEngine;
}

export interface RunCommandOptions extends AgentFlags {
  json?: boolean;
}

export const defaultRunContext: RunContext = {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin: async () => (process.stdin.isTTY ? undefined : text(process.stdin)),
  createEngine,
};

/**
 * `heaw run`: answers one prompt non-interactively. Nobody can approve actions, so anything that
 * needs approval is denied unless `--allow` rules or `--mode` permit it. Returns the exit code.
 */
export async function runCommand(
  promptParts: string[],
  options: RunCommandOptions,
  context: RunContext = defaultRunContext,
): Promise<number> {
  const prompt = promptParts.length ? promptParts.join(' ') : (await context.readStdin())?.trim();
  if (!prompt) {
    context.stderr.write('Provide a prompt: heaw run "your prompt", or pipe one in.\n');
    return 2;
  }

  let engine: Engine;
  try {
    const { options: engineOptions, warnings } = await setupEngine(options, {
      cwd: context.cwd,
      env: context.env,
      interactive: false,
      packageEntry: context.packageEntry,
    });
    for (const warning of warnings) context.stderr.write(`Warning: ${warning}\n`);
    engine = await context.createEngine(engineOptions);
  } catch (error) {
    const message = userFacingMessage(error);
    if (message === undefined) throw error;
    context.stderr.write(`${message}\n`);
    return 2;
  }

  const controller = new AbortController();
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  try {
    return await runPrompt(
      engine,
      prompt,
      { json: options.json, signal: controller.signal },
      context,
    );
  } finally {
    process.off('SIGINT', onInterrupt);
    await engine.dispose();
    // Setup created the workspace, so the engine leaves it alone; a Docker one has a container.
    await engine.workspace.dispose();
    if (engine.telemetryError) {
      context.stderr.write(`Could not send traces: ${engine.telemetryError}\n`);
    }
  }
}

/**
 * Streams one run: the answer to stdout, tool activity and the summary to stderr (or every event
 * as a JSON line with `json`). Returns the exit code.
 */
export async function runPrompt(
  engine: Engine,
  prompt: string,
  options: { json?: boolean | undefined; signal?: AbortSignal | undefined },
  io: { stdout: Output; stderr: Output },
): Promise<number> {
  let stopReason: StopReason = 'error';
  let atLineStart = true;
  const toolLabels = new Map<string, string>();
  /** Sub-agents' names by agent id, for their lines. */
  const agents = new Map<string, string>();
  const session = engine.session();
  // Saved runs can be continued interactively with `heaw resume <id>`.
  const footer = engine.sessionStore ? ` · session ${session.id}` : '';

  for await (const event of session.send(prompt, { signal: options.signal })) {
    const own = event.agentId === session.agentId;
    if (own && event.type === 'run.end') stopReason = event.stopReason;
    if (options.json) {
      io.stdout.write(`${JSON.stringify(event)}\n`);
      continue;
    }
    if (event.type === 'subagent.start') agents.set(event.childAgentId, event.name);
    // Sub-agents report back as a tool result; their own text is not the answer.
    if (event.type === 'text.delta') {
      if (!own) continue;
      io.stdout.write(event.text);
      atLineStart = event.text.endsWith('\n');
      continue;
    }
    if (event.type === 'tool.start') {
      toolLabels.set(`${event.agentId}:${event.callId}`, toolLabel(event.tool, event.args));
      continue;
    }
    if (!own && event.type === 'run.end') continue;
    const described = describeEvent(event, `${engine.model.id}`, toolLabels, footer);
    const line =
      own || !described
        ? described
        : `  [${agents.get(event.agentId) ?? event.agentId}] ${described.replaceAll('\n', '\n  ')}`;
    if (!line) continue;
    if (!atLineStart) {
      io.stdout.write('\n');
      atLineStart = true;
    }
    io.stderr.write(`${line}\n`);
  }

  // Runs sessionEnd hooks.
  for (const failure of await session.close()) {
    io.stderr.write(`The ${failure.hook} hook failed: ${failure.message}\n`);
  }
  return exitCodeFor(stopReason);
}

function describeEvent(
  event: EngineEvent,
  modelId: string,
  toolLabels: Map<string, string>,
  footer: string,
): string | undefined {
  switch (event.type) {
    case 'error': {
      const status = event.error.status ? ` (${event.error.status})` : '';
      if (!event.recoverable) return `Error${status}: ${event.error.message}`;
      // Only model errors are retried; hook and compaction errors are reported as they are.
      return event.error.name === 'HookError' || event.error.name === 'CompactionError'
        ? event.error.message
        : `Model call failed${status}, retrying: ${event.error.message}`;
    }
    case 'compaction': {
      const how =
        event.method === 'summary' ? 'older turns summarized' : 'old tool outputs cleared';
      return `[context] compacted ${event.beforeTokens} → ${event.afterTokens} tokens, ${how}`;
    }
    case 'subagent.start':
      return `[agent] ${event.name}: ${event.task.replace(/\s+/g, ' ').slice(0, 100)}`;
    case 'subagent.end': {
      const turns = `${event.turns} turn${event.turns === 1 ? '' : 's'}`;
      const cost = event.costUsd === undefined ? '' : ` · ${formatCost(event.costUsd)}`;
      const how = event.stopReason === 'end_turn' ? 'finished' : `stopped (${event.stopReason})`;
      return `[agent] ${event.name} ${how} · ${turns}${cost}`;
    }
    case 'hook':
      return event.hook === 'userPrompt'
        ? `Blocked by a userPrompt hook: ${event.message}`
        : `[hook] ${event.hook}: ${event.message.split('\n')[0]}`;
    case 'tool.end': {
      const label = toolLabels.get(`${event.agentId}:${event.callId}`) ?? event.tool;
      if (event.status === 'ok') return `[tool] ${label}`;
      if (event.status === 'denied') return `[denied] ${label}\n  ${event.output}`;
      if (event.status === 'cancelled') return `[cancelled] ${label}`;
      return `[failed] ${label}\n  ${failureSummary(event.output)}`;
    }
    case 'link':
      return event.kind === 'pull_request'
        ? `[link] pull request ${event.ref}`
        : `[link] commit ${event.ref.slice(0, 7)} ${event.title ?? ''}`.trimEnd();
    case 'run.end': {
      const { inputTokens, outputTokens } = event.usage;
      const turns = `${event.turns} turn${event.turns === 1 ? '' : 's'}`;
      const cost = event.costUsd === undefined ? '' : ` · ${formatCost(event.costUsd)}`;
      const summary = `${modelId} · ${turns} · ${inputTokens} in / ${outputTokens} out tokens${cost}${footer}`;
      const note = STOP_NOTES[event.stopReason];
      return note ? `${note}\n${summary}` : summary;
    }
    default:
      return undefined;
  }
}

const STOP_NOTES: Partial<Record<StopReason, string>> = {
  max_tokens: 'Stopped: the answer reached the model output limit and may be cut off.',
  max_turns: 'Stopped: reached the maximum number of turns.',
  token_limit: 'Stopped: reached the token limit (limits.maxTokens).',
  cost_limit: 'Stopped: reached the cost limit (--max-cost or limits.maxCostUsd).',
  check_failed:
    'Stopped: a check before finishing failed the same way 3 times; it needs you (fix what it reports, or the check in heaw.config.ts).',
  time_limit: 'Stopped: reached the time limit (--max-minutes or limits.maxMinutes).',
  content_filter: "Stopped: the provider's content filter blocked the answer.",
  aborted: 'Stopped: interrupted.',
};

function exitCodeFor(stopReason: StopReason): number {
  if (stopReason === 'end_turn') return 0;
  if (stopReason === 'aborted') return 130;
  return 1;
}
