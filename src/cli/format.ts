/** `run_command npm test`, `read_file src/a.ts`: the tool and its most telling argument. */
export function toolLabel(tool: string, args: unknown): string {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] : undefined);
  if (tool === 'delegate')
    return `delegate ${text('agent') ?? 'agent'}: ${short(text('task') ?? '')}`;
  if (tool === 'load_skill') {
    const file = text('file');
    return `load_skill ${text('name') ?? ''}${file ? ` (${file})` : ''}`;
  }
  const detail = ['command', 'pattern', 'path', 'url'].map(text).find(Boolean);
  return detail === undefined ? tool : `${tool} ${short(detail)}`;
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
