import { type NearLimit, nearLimitAmount } from '../core/loop.js';

/** `run_command npm test`, `read_file src/a.ts`: the tool and its most telling argument. */
export function toolLabel(tool: string, args: unknown): string {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] : undefined);
  if (tool === 'delegate')
    return `delegate ${text('agent') ?? 'agent'}: ${short(text('task') ?? '')}`;
  if (tool === 'finish_plan') return 'building the plan in PLAN.md';
  if (tool === 'start_plan') return `start_plan: ${short(text('reason') ?? '')}`;
  if (tool === 'load_skill') {
    const file = text('file');
    return `load_skill ${text('name') ?? ''}${file ? ` (${file})` : ''}`;
  }
  if (tool === 'run_command' && record.background === true) {
    return `run_command in the background: ${short(text('command') ?? '')}`;
  }
  if (tool === 'command_output' || tool === 'stop_command') {
    const id = typeof record.id === 'number' ? ` [${record.id}]` : '';
    const until = text('wait_for');
    return `${tool}${id}${until ? `, waiting for "${short(until)}"` : ''}`;
  }
  const detail = ['command', 'pattern', 'path', 'url'].map(text).find(Boolean);
  return detail === undefined ? tool : `${tool} ${short(detail)}`;
}

/** A run near one of its limits, for the user: what was used, and what the agent was asked. */
export function describeNearLimit(event: NearLimit): string {
  const share = Math.round((100 * event.used) / event.max);
  return (
    `This message has used ${share}% of its ${event.limit} limit (${nearLimitAmount(event)}), so ` +
    'the agent was asked to finish what it is doing and report what is left.'
  );
}

/** The agent going in circles, for the user: what heaw noticed and did about it. */
export function describeStuck(event: {
  signal: 'same-failure' | 'back-and-forth';
  subject: string;
  count: number;
}): string {
  const what =
    event.signal === 'same-failure'
      ? `${short(event.subject)} failed the same way ${event.count} times`
      : `${short(event.subject)} went back to earlier content ${event.count === 2 ? 'twice' : `${event.count} times`}`;
  return `${what}, so the agent was asked to step back and try a different approach.`;
}

function short(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

/**
 * One line saying why a tool failed. Command results end with a status line such as
 * `[exit code 1]`, which says more than the first line of output (often a banner).
 */
export function failureSummary(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim());
  const status = lines.at(-1)?.trim();
  const line = status && /^\[.*\]$/.test(status) ? status : (lines[0] ?? '');
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 950, 12.3k, 1.2M */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** $0.0042, $0.42, $12.30 */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}
