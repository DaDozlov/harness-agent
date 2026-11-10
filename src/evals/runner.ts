import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StopReason } from '../core/events.js';
import { lastAnswer, textOf, userMessage } from '../core/messages.js';
import type { ModelClient } from '../core/model.js';
import type { SessionRecord } from '../core/session-store.js';
import { addUsage, costOf, emptyUsage, type Usage } from '../core/usage.js';
import type { Workspace } from '../core/workspace.js';
import type { Engine } from '../engine.js';
import { stepLines } from '../observability/session-report.js';
import type { EvalCase, EvalCheck } from './cases.js';
import { average, formatTable, shortCount } from './format.js';

export interface CheckResult {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface TrialResult {
  trial: number;
  passed: boolean;
  stopReason: StopReason;
  checks: CheckResult[];
  usage: Usage;
  costUsd?: number;
  turns: number;
  durationMs: number;
  answer: string;
  /**
   * What happened, a line per step: tool calls with their failures, what heaw told the agent,
   * what the agent said. Why a trial failed is usually in here, not in the checks.
   */
  steps?: string[];
  /** Kept for inspection with `keep`. */
  dir?: string;
}

export interface CaseResult {
  name: string;
  source: string;
  passed: number;
  trials: TrialResult[];
}

export interface EvalReport {
  startedAt: string;
  model: string;
  /** The model that graded `judge` checks: reports compare fairly only with the same judge. */
  judgeModel?: string;
  cases: CaseResult[];
  passed: number;
  total: number;
  usage: Usage;
  costUsd?: number;
  /** Of the judge's model calls, counted apart from the agent's. */
  judgeUsage: Usage;
  durationMs: number;
}

export interface RunEvalsOptions {
  /** The engine for one trial, acting in `workspace` (a fresh copy of the fixture). */
  createEngine: (workspace: Workspace, evalCase: EvalCase) => Promise<Engine>;
  /** A workspace for a trial folder: local, or a container. */
  createWorkspace: (dir: string) => Workspace;
  /** Grades `judge` checks. */
  judge: ModelClient;
  /** Model id for the report. */
  model: string;
  /** Override every case's number of trials. */
  trials?: number;
  /** Keep the trial folders instead of deleting them. */
  keep?: boolean;
  onProgress?: (line: string) => void;
}

const MAX_DIFF_CHARS = 20_000;

/**
 * Runs each case's trials one after another (docs/DESIGN.md §4.16): copies the fixture into a
 * fresh folder, lets the agent work non-interactively, then runs the checks there.
 */
export async function runEvals(cases: EvalCase[], options: RunEvalsOptions): Promise<EvalReport> {
  const started = Date.now();
  let usage = emptyUsage();
  let judgeUsage = emptyUsage();
  let costUsd: number | undefined;
  const results: CaseResult[] = [];

  for (const evalCase of cases) {
    const trials: TrialResult[] = [];
    const count = options.trials ?? evalCase.trials;
    for (let trial = 1; trial <= count; trial++) {
      options.onProgress?.(`${evalCase.name} #${trial}/${count}…`);
      const result = await runTrial(evalCase, trial, options);
      usage = addUsage(usage, result.usage);
      judgeUsage = addUsage(judgeUsage, result.judgeUsage);
      if (result.trial.costUsd !== undefined) costUsd = (costUsd ?? 0) + result.trial.costUsd;
      trials.push(result.trial);
      options.onProgress?.(
        `${evalCase.name} #${trial}/${count}: ${result.trial.passed ? 'passed' : 'failed'}`,
      );
    }
    results.push({
      name: evalCase.name,
      source: evalCase.source,
      passed: trials.filter((trial) => trial.passed).length,
      trials,
    });
  }

  return {
    startedAt: new Date(started).toISOString(),
    model: options.model,
    judgeModel: options.judge.id,
    cases: results,
    passed: results.reduce((sum, item) => sum + item.passed, 0),
    total: results.reduce((sum, item) => sum + item.trials.length, 0),
    usage,
    ...(costUsd !== undefined && { costUsd }),
    judgeUsage,
    durationMs: Date.now() - started,
  };
}

async function runTrial(
  evalCase: EvalCase,
  trial: number,
  options: RunEvalsOptions,
): Promise<{ trial: TrialResult; usage: Usage; judgeUsage: Usage }> {
  const dir = await mkdtemp(join(tmpdir(), `heaw-eval-${slug(evalCase.name)}-`));
  const workspace = options.createWorkspace(dir);
  const started = Date.now();
  let judgeUsage = emptyUsage();
  try {
    if (evalCase.checkout) await checkOut(evalCase, dir);
    else if (evalCase.fixture) await cp(evalCase.fixture, dir, { recursive: true });
    // A commit of the fixture, so the judge sees exactly what the agent changed.
    await git(dir, ['init', '-q']);
    await git(dir, ['add', '-A']);
    await git(dir, [
      '-c',
      'user.name=heaw',
      '-c',
      'user.email=heaw@example.invalid',
      'commit',
      '-qm',
      'fixture',
      '--allow-empty',
    ]);

    if (evalCase.setup) {
      const setup = await workspace.exec(evalCase.setup, { timeoutMs: 10 * 60_000 });
      if (setup.exitCode !== 0) {
        return {
          trial: failed(
            trial,
            Date.now() - started,
            `setup "${evalCase.setup}" failed: ${tail(setup.output)}`,
          ),
          usage: emptyUsage(),
          judgeUsage,
        };
      }
    }

    const engine = await options.createEngine(workspace, evalCase);
    const session = engine.session();
    let end: { stopReason: StopReason; usage: Usage; turns: number; costUsd?: number } | undefined;
    // The run as a session log would hold it, for the trial's steps.
    const records: SessionRecord[] = [];
    try {
      for await (const event of session.send(evalCase.prompt)) {
        if (event.type === 'run.end' && event.agentId === session.agentId) end = event;
        if (event.type === 'text.delta' || event.type === 'reasoning.delta') continue;
        if (event.type !== 'message.complete') records.push({ type: 'event', event });
        else if (event.agentId === session.agentId) {
          records.push({ type: 'message', timestamp: event.timestamp, message: event.message });
        }
      }
    } finally {
      await engine.dispose();
    }
    const answer = lastAnswer(session.messages);
    const stopReason = end?.stopReason ?? 'error';
    const turns = end?.turns ?? 0;
    // Taken before the checks run: what they add (hidden tests, build output) is not the agent's.
    const changes = await agentChanges(dir);

    const checks: CheckResult[] = [];
    for (const check of evalCase.checks) {
      const result = await runCheck(check, {
        dir,
        workspace,
        answer,
        turns,
        changes,
        evalCase,
        judge: options.judge,
      });
      judgeUsage = addUsage(judgeUsage, result.usage);
      checks.push(result.result);
    }
    // A run that failed or was cut off does not pass, whatever the checks say.
    const finished = stopReason === 'end_turn';
    if (!finished)
      checks.push({ check: 'the run finished', passed: false, detail: `stopped: ${stopReason}` });
    return {
      trial: {
        trial,
        passed: checks.every((check) => check.passed),
        stopReason,
        checks,
        usage: end?.usage ?? emptyUsage(),
        ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
        turns,
        durationMs: Date.now() - started,
        answer,
        steps: stepLines(records) ?? [],
        ...(options.keep && { dir }),
      },
      usage: end?.usage ?? emptyUsage(),
      judgeUsage,
    };
  } catch (error) {
    return {
      trial: failed(trial, Date.now() - started, `the trial failed: ${(error as Error).message}`),
      usage: emptyUsage(),
      judgeUsage,
    };
  } finally {
    await workspace.dispose();
    if (!options.keep)
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}

async function runCheck(
  check: EvalCheck,
  trial: {
    dir: string;
    workspace: Workspace;
    answer: string;
    turns: number;
    /** The agent's changes as a diff. */
    changes: string;
    evalCase: EvalCase;
    judge: ModelClient;
  },
): Promise<{ result: CheckResult; usage: Usage }> {
  const none = emptyUsage();
  if ('maxTurns' in check) {
    const passed = trial.turns <= check.maxTurns;
    return {
      result: {
        check: `at most ${check.maxTurns} turns`,
        passed,
        ...(!passed && { detail: `took ${trial.turns}` }),
      },
      usage: none,
    };
  }
  if ('command' in check) {
    if (check.files) {
      try {
        await cp(check.files, trial.dir, { recursive: true, force: true });
      } catch (error) {
        return {
          result: {
            check: `${check.command} exits ${check.expectExitCode}`,
            passed: false,
            detail: `could not copy the check's files (${check.files}): ${(error as Error).message}`,
          },
          usage: none,
        };
      }
    }
    const run = await trial.workspace.exec(check.command, { timeoutMs: 10 * 60_000 });
    const passed = run.exitCode === check.expectExitCode;
    return {
      result: {
        check: `${check.command} exits ${check.expectExitCode}`,
        passed,
        ...(!passed && {
          detail: `exited ${run.exitCode ?? '(stopped)'}${run.timedOut ? ' (timed out)' : ''}: ${failureOf(run.output)}`,
        }),
      },
      usage: none,
    };
  }
  if ('answerContains' in check) {
    const passed = trial.answer.toLowerCase().includes(check.answerContains.toLowerCase());
    return {
      result: {
        check: `the answer contains "${check.answerContains}"`,
        passed,
        ...(!passed && { detail: `answer: ${trial.answer.slice(0, 200) || '(none)'}` }),
      },
      usage: none,
    };
  }
  if ('file' in check) {
    const label = check.contains
      ? `${check.file} contains "${check.contains}"`
      : `${check.file} ${check.exists ? 'exists' : 'does not exist'}`;
    const content = await readFile(trial.workspace.resolve(check.file), 'utf8').catch(
      () => undefined,
    );
    const passed =
      content === undefined
        ? !check.exists
        : check.exists && (check.contains === undefined || content.includes(check.contains));
    return { result: { check: label, passed }, usage: none };
  }
  return judge(check.judge, trial);
}

const JUDGE_SYSTEM =
  "You check whether an AI agent did a task. You get the task, one criterion, the agent's " +
  'final answer and the changes it made. Judge only the criterion, strictly but fairly. Answer ' +
  'with JSON only: {"pass": true or false, "reason": "one sentence"}.';

/** What the agent changed in the trial folder, as a diff against the fixture. */
async function agentChanges(dir: string): Promise<string> {
  await git(dir, ['add', '-A']);
  const diff = (await git(dir, ['diff', '--cached', '--stat', '--patch'])) ?? '';
  if (!diff.trim()) return '(no changes)';
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut]` : diff;
}

async function judge(
  criterion: string,
  trial: { answer: string; changes: string; evalCase: EvalCase; judge: ModelClient },
): Promise<{ result: CheckResult; usage: Usage }> {
  const prompt = [
    `Task given to the agent:\n${trial.evalCase.prompt}`,
    `Criterion:\n${criterion}`,
    `The agent's final answer:\n${trial.answer || '(none)'}`,
    `Changes it made (git diff):\n${trial.changes}`,
  ].join('\n\n');
  for await (const event of trial.judge.stream({
    system: JUDGE_SYSTEM,
    messages: [userMessage(prompt)],
  })) {
    if (event.type !== 'finish') continue;
    const verdict = parseVerdict(textOf(event.message));
    return {
      result: {
        check: `judge: ${criterion}`,
        passed: verdict.pass,
        ...(verdict.reason && { detail: verdict.reason }),
      },
      usage: event.usage,
    };
  }
  return {
    result: { check: `judge: ${criterion}`, passed: false, detail: 'the judge gave no answer' },
    usage: emptyUsage(),
  };
}

/** `{"pass": true, "reason": "…"}`, possibly wrapped in prose or a code fence. */
export function parseVerdict(text: string): { pass: boolean; reason?: string } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as { pass?: unknown; reason?: unknown };
      if (typeof parsed.pass === 'boolean') {
        return {
          pass: parsed.pass,
          ...(typeof parsed.reason === 'string' && { reason: parsed.reason }),
        };
      }
    } catch {
      // Fall through to the words.
    }
  }
  return {
    pass: /\bpass(ed)?\b/i.test(text) && !/\bfail(ed)?\b/i.test(text),
    reason: text.trim().slice(0, 200),
  };
}

/** The report as a table, with what failed. */
export function formatEvalReport(report: EvalReport): string {
  const rows = report.cases.map((item) => {
    const trials = item.trials.length || 1;
    const tokens = item.trials.reduce(
      (sum, trial) => sum + trial.usage.inputTokens + trial.usage.outputTokens,
      0,
    );
    const costs = item.trials.map((trial) => trial.costUsd);
    const cost = costs.every((value) => value === undefined)
      ? '—'
      : `$${(costs.reduce<number>((sum, value) => sum + (value ?? 0), 0) / trials).toFixed(4)}`;
    const time = item.trials.reduce((sum, trial) => sum + trial.durationMs, 0) / trials;
    const turns = item.trials.reduce((sum, trial) => sum + trial.turns, 0) / trials;
    return [
      item.name,
      `${item.passed}/${item.trials.length}`,
      average(turns),
      shortCount(tokens / trials),
      cost,
      `${(time / 1000).toFixed(1)}s`,
    ];
  });
  const header = ['case', 'passed', 'turns/trial', 'tokens/trial', 'cost/trial', 'time/trial'];
  const failures = report.cases.flatMap((item) =>
    item.trials
      .filter((trial) => !trial.passed)
      .flatMap((trial) =>
        trial.checks
          .filter((check) => !check.passed)
          .map(
            (check) =>
              `  ${item.name} #${trial.trial}: ${check.check}${check.detail ? ` — ${check.detail}` : ''}`,
          ),
      ),
  );
  const cost = report.costUsd === undefined ? '' : ` · $${report.costUsd.toFixed(4)}`;
  return [
    ...formatTable(header, rows),
    '',
    `${report.passed}/${report.total} trials passed · ${report.model}${cost} · ${(report.durationMs / 1000).toFixed(1)}s`,
    ...(failures.length ? ['', 'Failed:', ...failures] : []),
  ].join('\n');
}

/** Cost of the judge's calls, when its price is known. */
export function judgeCost(report: EvalReport, judge: ModelClient): number | undefined {
  return costOf(report.judgeUsage, judge.capabilities.pricing);
}

function failed(trial: number, durationMs: number, detail: string): TrialResult {
  return {
    trial,
    passed: false,
    stopReason: 'error',
    checks: [{ check: 'the trial ran', passed: false, detail }],
    usage: emptyUsage(),
    turns: 0,
    durationMs,
    answer: '',
  };
}

/** The case's repository at its `checkout` commit, in the trial folder. */
async function checkOut(evalCase: EvalCase, dir: string): Promise<void> {
  const repo = (await git(dirname(evalCase.source), ['rev-parse', '--show-toplevel']))?.trim();
  if (!repo) {
    throw new Error(
      `${evalCase.source} is not in a git repository, so there is nothing to check out.`,
    );
  }
  await gitOrThrow(dir, ['clone', '--quiet', '--no-checkout', repo, '.']);
  await gitOrThrow(dir, ['checkout', '--quiet', '--detach', evalCase.checkout!]);
  // A push from the trial must never reach the project's repository.
  await git(dir, ['remote', 'remove', 'origin']);
}

function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 10_000_000 },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`))
          : done(stdout),
    );
  });
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 10_000_000 }, (error, stdout) =>
      done(error ? undefined : stdout),
    );
  });
}

function tail(output: string): string {
  const text = output.trim();
  return text.length > 300 ? `…${text.slice(-300)}` : text || '(no output)';
}

/**
 * Why a command failed: the lines that name the failure (a failing test, an assertion with what
 * it expected and got, an error), else the end of the output. The end of a test runner's output
 * is often a stack trace that says nothing.
 */
function failureOf(output: string): string {
  const telling = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /^(not ok|✖|×|FAIL\b)|AssertionError|^Error\b|\b\w*Error:|^(expected|actual|message)\b|^[+-] /i.test(
        line,
      ),
    )
    .filter((line) => !/^✖ failing tests:?$/.test(line));
  if (!telling.length) return tail(output);
  const text = [...new Set(telling)].join(' | ');
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30);
}
