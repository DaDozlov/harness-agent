import { formatTable, localTime, shortCount } from './format.js';
import type { CaseResult, EvalReport } from './runner.js';

export interface CaseComparison {
  name: string;
  /** `new` and `removed`: the case is in only one of the reports. */
  change: 'better' | 'worse' | 'same' | 'new' | 'removed';
}

/** Each case's pass rate, tokens and cost before and after, e.g. a prompt or model change. */
export function compareReports(
  before: EvalReport,
  after: EvalReport,
): { cases: CaseComparison[]; text: string } {
  const names = [
    ...after.cases.map((item) => item.name),
    ...before.cases.map((item) => item.name).filter((name) => !find(after, name)),
  ];
  const cases = names.map((name) => ({
    name,
    change: change(find(before, name), find(after, name)),
  }));
  const rows = names.map((name, index) => {
    const old = find(before, name);
    const now = find(after, name);
    return [
      name,
      `${passed(old)} → ${passed(now)}`,
      `${tokens(old)} → ${tokens(now)}`,
      `${cost(old)} → ${cost(now)}`,
      cases[index]!.change,
    ];
  });
  const worse = cases.filter((item) => item.change === 'worse').map((item) => item.name);
  const text = [
    ...formatTable(['case', 'passed', 'tokens/trial', 'cost/trial', 'change'], rows),
    '',
    `before: ${summary(before)}`,
    `after:  ${summary(after)}`,
    ...(worse.length ? [`Worse: ${worse.join(', ')}`] : []),
  ].join('\n');
  return { cases, text };
}

function find(report: EvalReport, name: string): CaseResult | undefined {
  return report.cases.find((item) => item.name === name);
}

function rate(item: CaseResult): number {
  return item.trials.length ? item.passed / item.trials.length : 0;
}

function change(
  old: CaseResult | undefined,
  now: CaseResult | undefined,
): CaseComparison['change'] {
  if (!old) return 'new';
  if (!now) return 'removed';
  const difference = rate(now) - rate(old);
  if (difference > 0) return 'better';
  return difference < 0 ? 'worse' : 'same';
}

function passed(item: CaseResult | undefined): string {
  return item ? `${item.passed}/${item.trials.length}` : '—';
}

function tokens(item: CaseResult | undefined): string {
  if (!item?.trials.length) return '—';
  const total = item.trials.reduce(
    (sum, trial) => sum + trial.usage.inputTokens + trial.usage.outputTokens,
    0,
  );
  return shortCount(total / item.trials.length);
}

function cost(item: CaseResult | undefined): string {
  const costs = item?.trials.map((trial) => trial.costUsd) ?? [];
  if (!costs.length || costs.every((value) => value === undefined)) return '—';
  const total = costs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return `$${(total / costs.length).toFixed(4)}`;
}

function summary(report: EvalReport): string {
  const price = report.costUsd === undefined ? '' : ` · $${report.costUsd.toFixed(4)}`;
  return `${report.passed}/${report.total} passed · ${report.model}${price} · ${localTime(report.startedAt)}`;
}
