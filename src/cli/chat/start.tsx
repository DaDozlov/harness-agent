import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink';
import { findProjectRoot } from '../../config/project.js';
import type { Session } from '../../core/session.js';
import { createEngine, type Engine } from '../../engine.js';
import { type AgentFlags, setupEngine, userFacingMessage } from '../setup.js';
import { type ChatStart, ChatRoot } from './ChatRoot.js';
import { bypassNotice } from './commands.js';
import { type EngineFactory, SetupWatcher } from './reload.js';

export interface ChatOptions extends AgentFlags {
  /** `-c`: continue the most recent conversation. */
  continue?: boolean;
  /** `heaw resume [id]`: an id resumes it, `true` shows a picker. */
  resume?: string | true;
}

/** `heaw` and `heaw resume`: the interactive chat. Returns the exit code. */
export async function startChat(
  options: ChatOptions,
  context: { packageEntry?: string | undefined } = {},
): Promise<number> {
  const { stdin, stdout, stderr, env } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write(
      'The chat needs an interactive terminal. For scripts and pipes, use: heaw run "your prompt"\n',
    );
    return 2;
  }

  const setup = () =>
    setupEngine(options, {
      cwd: process.cwd(),
      env,
      interactive: true,
      packageEntry: context.packageEntry,
    });
  const projectRoot = findProjectRoot(process.cwd());
  // Setup files changed since the last load are applied before the next message.
  const setupWatcher = await SetupWatcher.start(projectRoot);
  // `/reload`: the config files as they are now, and variables added to .env since the start.
  const reloadEngine: EngineFactory = async () => {
    await setupWatcher.accept();
    const dotenv = join(projectRoot, '.env');
    if (existsSync(dotenv)) process.loadEnvFile(dotenv);
    const { options: engineOptions, warnings } = await setup();
    return { engine: await createEngine(engineOptions), warnings };
  };

  let engine: Engine;
  let start: ChatStart;
  try {
    const { options: engineOptions, warnings } = await setup();
    for (const warning of warnings) stderr.write(`Warning: ${warning}\n`);
    engine = await createEngine(engineOptions);
    if (engineOptions.permissions?.mode === 'bypass') {
      stderr.write(`${bypassNotice(engine.workspace.kind).text}\n`);
    }
    try {
      start = await chooseStart(engine, options);
    } catch (error) {
      await engine.dispose();
      await engine.workspace.dispose();
      throw error;
    }
  } catch (error) {
    const message = userFacingMessage(error);
    if (message === undefined) throw error;
    stderr.write(`${message}\n`);
    return 2;
  }

  let current: Session | undefined = start.kind === 'session' ? start.session : undefined;
  const app = render(
    <ChatRoot
      engine={engine}
      start={start}
      onSessionChange={(session) => (current = session)}
      reloadEngine={reloadEngine}
      setupChanges={() => setupWatcher.changes()}
      onEngineChange={(next) => (engine = next)}
    />,
    { exitOnCtrlC: false },
  );
  // Closing the terminal (SIGHUP, also on Windows) or a kill ends the chat the normal way, so
  // running commands, background ones included, are stopped before heaw exits.
  const hangUp = () => app.unmount();
  process.once('SIGHUP', hangUp);
  process.once('SIGTERM', hangUp);
  try {
    await app.waitUntilExit();
  } finally {
    process.off('SIGHUP', hangUp);
    process.off('SIGTERM', hangUp);
    // Runs sessionEnd hooks and saves what is left.
    const failures = (await current?.close()) ?? [];
    for (const failure of failures) {
      stderr.write(`The ${failure.hook} hook failed: ${failure.message}\n`);
    }
    await engine.dispose();
    // Setup created the workspace, so the engine leaves it alone; a Docker one has a container.
    await engine.workspace.dispose();
    if (engine.telemetryError) stderr.write(`Could not send traces: ${engine.telemetryError}\n`);
  }
  if (current?.messages.length && engine.sessionStore) {
    stdout.write(`Conversation saved. Continue it with: heaw resume ${current.id}\n`);
  }
  return 0;
}

async function chooseStart(engine: Engine, options: ChatOptions): Promise<ChatStart> {
  if (options.continue) {
    const [latest] = await engine.sessions(1);
    if (latest) return { kind: 'session', session: await engine.resume(latest.id), resumed: true };
    process.stderr.write('No saved conversation here yet; starting a new one.\n');
  } else if (typeof options.resume === 'string') {
    return { kind: 'session', session: await engine.resume(options.resume), resumed: true };
  } else if (options.resume === true) {
    const sessions = await engine.sessions(20);
    if (sessions.length) return { kind: 'pick', sessions };
    process.stderr.write('No saved conversation here yet; starting a new one.\n');
  }
  return { kind: 'session', session: engine.session(), resumed: false };
}
