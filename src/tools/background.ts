import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { ToolOutput } from '../core/tools.js';
import type { ExecResult, Workspace } from '../core/workspace.js';
import { collapseProgress } from '../workspace/exec.js';
import { defineTool } from './define.js';

/** At most this many commands run in the background at once, per workspace. */
const MAX_RUNNING = 5;
/** Output kept per command; older output is dropped. */
const KEPT_CHARS = 200_000;
/** Output returned per call; the rest of it stays readable only as the latest part. */
const SHOWN_CHARS = 20_000;
/** How long `run_command` waits for a background command's first output. */
const STARTUP_WAIT_MS = 3_000;
const MAX_WAIT_SECONDS = 120;
/** A background command runs until stopped, or until heaw exits (the workspace stops it). */
const NO_TIMEOUT_MS = 24 * 60 * 60_000;

interface BackgroundCommand {
  id: number;
  command: string;
  started: number;
  /** The latest output, up to KEPT_CHARS. */
  output: string;
  /** Characters of output so far, kept or dropped. */
  total: number;
  /** Characters of output already returned to the model. */
  read: number;
  stop: AbortController;
  done: Promise<void>;
  result?: ExecResult;
}

/**
 * Background commands by workspace: the main agent and its sub-agents share them, and they stop
 * with the workspace (when heaw exits, or `/reload` replaces it).
 */
const registries = new WeakMap<Workspace, { next: number; commands: BackgroundCommand[] }>();

function registry(workspace: Workspace) {
  let found = registries.get(workspace);
  if (!found) registries.set(workspace, (found = { next: 1, commands: [] }));
  return found;
}

/** Commands still running in the background of a workspace, e.g. to say they stop on reload. */
export function runningInBackground(workspace: Workspace): string[] {
  return (registries.get(workspace)?.commands ?? [])
    .filter((entry) => !entry.result)
    .map((entry) => entry.command);
}

/** `run_command` with `background: true`: starts it, waits briefly for its first output. */
export async function startInBackground(
  workspace: Workspace,
  command: string,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const all = registry(workspace);
  const running = all.commands.filter((entry) => !entry.result);
  if (running.length >= MAX_RUNNING) {
    return {
      output:
        `${running.length} commands already run in the background:\n${running.map(describe).join('\n')}\n` +
        'Stop one with stop_command first.',
      isError: true,
    };
  }
  const stop = new AbortController();
  const entry: BackgroundCommand = {
    id: all.next++,
    command,
    started: Date.now(),
    output: '',
    total: 0,
    read: 0,
    stop,
    done: Promise.resolve(),
  };
  entry.done = workspace
    .exec(command, {
      cwd,
      timeoutMs: NO_TIMEOUT_MS,
      signal: stop.signal,
      onOutput: (text) => {
        entry.total += text.length;
        entry.output = (entry.output + text).slice(-KEPT_CHARS);
      },
    })
    .then((result) => {
      entry.result = result;
    });
  all.commands.push(entry);
  await waitFor(entry, { ms: STARTUP_WAIT_MS }, signal);
  return report(entry, 'Started in the background');
}

export const commandOutput = defineTool({
  name: 'command_output',
  description:
    'Read the new output of a command started with run_command and background: true, and ' +
    'whether it still runs. Can wait for a text to appear (e.g. a server saying it is ready) ' +
    'or for the command to end. Without an id, lists the background commands.',
  kind: 'read',
  concurrency: 'serial',
  parameters: z.object({
    id: z.number().int().optional().describe('The id run_command gave'),
    wait_for: z
      .string()
      .optional()
      .describe('Wait until the output contains this text, e.g. "Started" or "listening"'),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe('Wait at most this long for wait_for, or for the command to end (default 0)'),
  }),
  async run({ id, wait_for, wait_seconds }, { workspace, signal }) {
    const commands = registries.get(workspace)?.commands ?? [];
    if (id === undefined) {
      return commands.length
        ? commands.map(describe).join('\n')
        : 'No commands were started in the background.';
    }
    const entry = commands.find((candidate) => candidate.id === id);
    if (!entry) return { output: `No background command ${id}.`, isError: true };
    const seconds = wait_seconds ?? (wait_for ? 30 : 0);
    const found = await waitFor(entry, { ms: seconds * 1000, text: wait_for }, signal);
    const missed = wait_for && !found ? `"${wait_for}" did not appear within ${seconds} s.\n` : '';
    return report(entry, missed ? `${missed}Command` : 'Command');
  },
});

export const stopCommand = defineTool({
  name: 'stop_command',
  description:
    'Stop a command started with run_command and background: true, with everything it started.',
  // It only stops what heaw started itself, so it needs no approval.
  kind: 'read',
  concurrency: 'serial',
  parameters: z.object({ id: z.number().int().describe('The id run_command gave') }),
  async run({ id }, { workspace }) {
    const entry = registries.get(workspace)?.commands.find((candidate) => candidate.id === id);
    if (!entry) return { output: `No background command ${id}.`, isError: true };
    if (entry.result) return report(entry, 'Already ended');
    entry.stop.abort();
    await Promise.race([entry.done, sleep(10_000)]);
    return report(entry, 'Stopped');
  },
});

/** Waits until the command ends, `text` is in its output, or the time is up. */
async function waitFor(
  entry: BackgroundCommand,
  until: { ms: number; text?: string | undefined },
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + until.ms;
  for (;;) {
    // All output counts: the text may have come with the start report already.
    if (until.text && entry.output.includes(until.text)) return true;
    if (entry.result || signal.aborted || Date.now() >= deadline) return false;
    await sleep(Math.min(200, deadline - Date.now())).catch(() => undefined);
  }
}

function unread(entry: BackgroundCommand): string {
  return entry.output.slice(Math.max(0, entry.output.length - (entry.total - entry.read)));
}

/** The command's state and its output since the last report, which then counts as read. */
function report(entry: BackgroundCommand, lead: string): string {
  const dropped = entry.total - entry.read - unread(entry).length;
  let output = collapseProgress(unread(entry));
  entry.read = entry.total;
  if (output.length > SHOWN_CHARS) output = `[…]\n${output.slice(-SHOWN_CHARS)}`;
  else if (dropped > 0) output = `[…]\n${output}`;
  return [
    `${lead}: ${describe(entry)}`,
    output.trimEnd() ? `New output:\n${output.trimEnd()}` : '(no new output)',
  ].join('\n');
}

function describe(entry: BackgroundCommand): string {
  const ms = entry.result ? entry.result.durationMs : Date.now() - entry.started;
  const seconds = Math.round(ms / 1000);
  const state = !entry.result
    ? `running for ${seconds} s`
    : entry.result.exitCode === null
      ? `stopped after ${seconds} s`
      : `exited with code ${entry.result.exitCode} after ${seconds} s`;
  return `[${entry.id}] ${entry.command} (${state})`;
}
