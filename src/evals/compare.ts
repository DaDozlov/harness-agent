import { average, formatTable, localTime, shortCount } from './format.js';
import type { CaseResult, EvalReport } from './runner.js';

export interface CaseComparison {
  name: string;
  /** `new` and `removed`: the case is in only one of the reports. */
  change: 'better' | 'worse' | 'same' | 'new' | 'removed';
}

/**
 * Each case's pass rate, turns, tokens, cost and time before and after: a change to a prompt,
 * hook or skill, or another model (the summary lines name the model of each report).
 */
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
      `${turns(old)} → ${turns(now)}`,
      `${tokens(old)} → ${tokens(now)}`,
      `${cost(old)} → ${cost(now)}`,
      `${time(old)} → ${time(now)}`,
      cases[index]!.change,
    ];
  });
  const worse = cases.filter((item) => item.change === 'worse').map((item) => item.name);
  const header = [
    'case',
    'passed',
    'turns/trial',
    'tokens/trial',
    'cost/trial',
    'time/trial',
    'change',
  ];
  const judges =
    before.judgeModel && after.judgeModel && before.judgeModel !== after.judgeModel
      ? [
          `Judged by different models (${before.judgeModel}, then ${after.judgeModel}): ` +
            'judge checks may not compare. Use the same --judge-model for both runs.',
        ]
      : [];
  const text = [
    ...formatTable(header, rows),
    '',
    `before: ${summary(before)}`,
    `after:  ${summary(after)}`,
    ...(worse.length ? [`Worse: ${worse.join(', ')}`] : []),
    ...judges,
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

/** The mean over a case's trials, or undefined without trials. */
function mean(
  item: CaseResult | undefined,
  value: (trial: CaseResult['trials'][number]) => number,
): number | undefined {
  if (!item?.trials.length) return undefined;
  return item.trials.reduce((sum, trial) => sum + value(trial), 0) / item.trials.length;
}

function turns(item: CaseResult | undefined): string {
  const value = mean(item, (trial) => trial.turns);
  return value === undefined ? '—' : average(value);
}

function tokens(item: CaseResult | undefined): string {
  const value = mean(item, (trial) => trial.usage.inputTokens + trial.usage.outputTokens);
  return value === undefined ? '—' : shortCount(value);
}

function time(item: CaseResult | undefined): string {
  const value = mean(item, (trial) => trial.durationMs);
  return value === undefined ? '—' : `${Math.round(value / 1000)}s`;
}

function cost(item: CaseResult | undefined): string {
  const costs = item?.trials.map((trial) => trial.costUsd) ?? [];
  if (!costs.length || costs.every((value) => value === undefined)) return '—';
  const total = costs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return `$${(total / costs.length).toFixed(4)}`;
}

function summary(report: EvalReport): string {
  const price = report.costUsd === undefined ? '' : ` · $${report.costUsd.toFixed(4)}`;
  const took = ` · ${Math.round(report.durationMs / 60_000)} min`;
  return `${report.passed}/${report.total} passed · ${report.model}${price}${took} · ${localTime(report.startedAt)}`;
}
