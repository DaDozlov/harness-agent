import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadInstructions } from '../../config/instructions.js';
import { heawHome } from '../../config/project.js';
import { loadAgentDefinitions } from '../../agents/definitions.js';
import type { ModelClient } from '../../core/model.js';
import type { PermissionMode } from '../../core/permissions.js';
import type { Workspace } from '../../core/workspace.js';
import type { EngineOptions } from '../../engine.js';
import { type EvalCase, loadEvalCases } from '../../evals/cases.js';
import type { Env } from '../../providers/registry.js';
import { compareReports } from '../../evals/compare.js';
import { type EvalReport, formatEvalReport, judgeCost, runEvals } from '../../evals/runner.js';
import { DockerWorkspace } from '../../workspace/docker.js';
import { type AgentFlags, setupEngine, userFacingMessage } from '../setup.js';
import type { Output, RunContext } from './run.js';

export interface EvalCommandOptions extends AgentFlags {
  /** Override every case's number of trials. */
  trials?: number;
  /** Run the trials in Docker containers, even without `workspace.type: 'docker'`. */
  docker?: boolean;
  /** Keep the trial folders to look at afterwards. */
  keep?: boolean;
  /** Print the report as JSON. */
  json?: boolean;
  /** The model that grades `judge` checks. Default: the agent's model. */
  judgeModel?: string;
  /** A report to compare this run with: a file, or `latest` for the most recent one. */
  compare?: string;
}

/**
 * `heaw eval [filter]` (docs/DESIGN.md §4.16): runs the cases in `evals/`, prints a table and
 * saves a JSON report in `.heaw/evals/`. Returns 0 when every trial passed.
 */
export async function evalCommand(
  filter: string | undefined,
  options: EvalCommandOptions,
  context: Omit<RunContext, 'readStdin'>,
): Promise<number> {
  let setup: Awaited<ReturnType<typeof setupEngine>>;
  try {
    setup = await setupEngine(options, {
      cwd: context.cwd,
      env: context.env,
      interactive: false,
      packageEntry: context.packageEntry,
    });
  } catch (error) {
    const message = userFacingMessage(error);
    if (message === undefined) throw error;
    context.stderr.write(`${message}\n`);
    return 2;
  }
  // Trials get workspaces of their own; this one is not used.
  await setup.options.workspace?.dispose();
  for (const warning of setup.warnings) context.stderr.write(`Warning: ${warning}\n`);

  const { projectRoot } = setup.loaded;
  const evalsDir = join(projectRoot, 'evals');
  const { items: cases, problems } = await loadEvalCases(evalsDir, filter);
  for (const problem of problems) context.stderr.write(`Skipped ${problem}\n`);
  if (!cases.length) {
    context.stderr.write(
      filter
        ? `No eval case matches "${filter}" in ${relative(context.cwd, evalsDir) || evalsDir}.\n`
        : `No eval cases in ${relative(context.cwd, evalsDir) || 'evals'}/. Add one as evals/<name>.yaml (see docs/evals.md).\n`,
    );
    return 2;
  }
  let baseline: { report: EvalReport; file: string } | undefined;
  if (options.compare) {
    try {
      baseline = await baselineReport(options.compare, projectRoot, context.cwd);
    } catch (error) {
      context.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
  }

  const base = setup.options;
  // The engine without tools gives the model clients: the agent's and the judge's.
  const probe = await context.createEngine({
    ...base,
    toolsets: [],
    tools: [],
    git: false,
    mcp: undefined,
  });
  const judge = options.judgeModel ? await probe.createModel(options.judgeModel) : probe.model;
  await probe.dispose();

  const configured = setup.options.workspace?.kind;
  const createWorkspace =
    options.docker && configured !== 'docker'
      ? (dir: string): Workspace => new DockerWorkspace(dir)
      : setup.createWorkspace;

  const report = await runEvals(cases, {
    model: probe.model.id,
    judge,
    ...(options.trials !== undefined && { trials: options.trials }),
    ...(options.keep && { keep: true }),
    onProgress: (line) => context.stderr.write(`${line}\n`),
    createWorkspace,
    createEngine: async (workspace, evalCase) =>
      context.createEngine(
        await trialOptions(
          { ...base, model: probe.model },
          workspace,
          evalCase,
          options.mode,
          context.env,
        ),
      ),
  });

  const saved = await saveReport(projectRoot, report);
  const comparison = baseline && compareReports(baseline.report, report);
  if (options.json) {
    const output = comparison ? { ...report, comparison: comparison.cases } : report;
    context.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return report.passed === report.total ? 0 : 1;
  }
  const graded = judgeCost(report, judge);
  context.stdout.write(`${formatEvalReport(report)}\n`);
  if (graded) context.stdout.write(`Judging cost $${graded.toFixed(4)} (${judge.id}).\n`);
  const failed = report.passed < report.total;
  context.stdout.write(
    `Report: ${relative(context.cwd, saved) || saved}` +
      `${failed ? ' (with the steps and answer of each trial, to see why one failed)' : ''}\n`,
  );
  if (comparison && baseline) {
    const from = relative(context.cwd, baseline.file) || baseline.file;
    context.stdout.write(`\nCompared with ${from}:\n${comparison.text}\n`);
  }
  return report.passed === report.total ? 0 : 1;
}

/**
 * `heaw eval compare <before> <after>`: two saved reports side by side. Returns 1 when a case got
 * worse, so it can gate a change in CI.
 */
export async function evalCompareCommand(
  before: string,
  after: string,
  context: { cwd: string; stdout: Output; stderr: Output },
): Promise<number> {
  try {
    const [old, now] = await Promise.all([
      readReport(resolve(context.cwd, before)),
      readReport(resolve(context.cwd, after)),
    ]);
    const { cases, text } = compareReports(old, now);
    context.stdout.write(`${text}\n`);
    return cases.some((item) => item.change === 'worse') ? 1 : 0;
  } catch (error) {
    context.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

/** A report file, or the most recent saved one for `latest`. */
async function baselineReport(
  spec: string,
  projectRoot: string,
  cwd: string,
): Promise<{ report: EvalReport; file: string }> {
  if (spec !== 'latest') {
    const file = resolve(cwd, spec);
    return { report: await readReport(file), file };
  }
  const dir = join(projectRoot, '.heaw', 'evals');
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .at(-1);
  if (!newest) throw new Error('No saved eval report to compare with yet (.heaw/evals/).');
  const file = join(dir, newest);
  return { report: await readReport(file), file };
}

async function readReport(file: string): Promise<EvalReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the eval report ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!Array.isArray((parsed as { cases?: unknown } | null)?.cases)) {
    throw new Error(`${file} is not an eval report (heaw eval --json, or .heaw/evals/*.json).`);
  }
  return parsed as EvalReport;
}

/** Tools `loadProject` adds that inspect the project heaw runs in, which is not the trial's. */
const PROJECT_TOOLS = new Set(['check_config', 'session_report']);

/** The project's engine settings, confined to one trial's folder. */
async function trialOptions(
  base: EngineOptions,
  workspace: Workspace,
  evalCase: EvalCase,
  modeFlag: PermissionMode | undefined,
  env: Env,
): Promise<EngineOptions> {
  return {
    ...base,
    ...(evalCase.agents && { agents: await fixtureAgents(base, workspace) }),
    ...(evalCase.contextWindow &&
      typeof base.model !== 'string' && { model: withWindow(base.model, evalCase.contextWindow) }),
    workspace,
    interactive: false,
    sessionStore: undefined,
    // MCP servers act on the outside world; trials stay in their folder.
    mcp: undefined,
    // Nor do trials get the tools that look at this project's own setup and sessions.
    ...(base.tools && { tools: base.tools.filter((tool) => !PROJECT_TOOLS.has(tool.name)) }),
    instructions: await loadInstructions({ projectRoot: workspace.root, heawHome: heawHome(env) }),
    permissions: {
      ...base.permissions,
      // A flag wins, then the case; trials in a container may do anything inside it.
      mode: modeFlag ?? evalCase.mode ?? (workspace.kind === 'docker' ? 'bypass' : 'accept-edits'),
      preapproved: [...(base.permissions?.preapproved ?? []), ...evalCase.allow],
      deny: [...(base.permissions?.deny ?? []), ...evalCase.deny],
    },
    limits: { ...base.limits, ...evalCase.limits },
  };
}

/** The project's agents and the fixture's own (`.heaw/agents/`), which win by name. */
async function fixtureAgents(base: EngineOptions, workspace: Workspace) {
  // Its own `.heaw` as the personal folder too: no one's personal agents get into a trial.
  const own = join(workspace.root, '.heaw');
  const loaded = await loadAgentDefinitions({ projectRoot: workspace.root, heawHome: own });
  if (loaded.problems.length) throw new Error(loaded.problems.join('\n'));
  const names = new Set(loaded.items.map((agent) => agent.name));
  return [...(base.agents ?? []).filter((agent) => !names.has(agent.name)), ...loaded.items];
}

/** The model with a smaller context window, so compaction comes sooner. */
function withWindow(model: ModelClient, contextWindow: number): ModelClient {
  const maxOutputTokens = Math.min(
    model.capabilities.maxOutputTokens,
    Math.floor(contextWindow / 4),
  );
  return {
    id: model.id,
    capabilities: { ...model.capabilities, contextWindow, maxOutputTokens },
    stream: (request, signal) => model.stream(request, signal),
  };
}

async function saveReport(projectRoot: string, report: object): Promise<string> {
  const dir = join(projectRoot, '.heaw', 'evals');
  await mkdir(dir, { recursive: true });
  // Reports stay out of git, like sessions.
  await writeFile(join(dir, '.gitignore'), '*\n');
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
