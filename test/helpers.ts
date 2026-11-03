import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { EngineEvent } from '../src/core/events.js';
import type { Tool, ToolContext } from '../src/core/tools.js';
import { LocalWorkspace } from '../src/workspace/local.js';

/** A fresh LocalWorkspace in a temporary folder, removed after the test. */
export function tempWorkspaceFactory(): () => Promise<LocalWorkspace> {
  const created: LocalWorkspace[] = [];
  afterEach(async () => {
    for (const workspace of created.splice(0)) {
      await workspace.dispose();
      await rm(workspace.root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  return async () => {
    const workspace = new LocalWorkspace(await mkdtemp(join(tmpdir(), 'heaw-test-')));
    created.push(workspace);
    return workspace;
  };
}

export function toolContext(
  workspace: LocalWorkspace,
  state = new Map<string, unknown>(),
): ToolContext {
  return { workspace, signal: new AbortController().signal, callId: 'call_1', state };
}

/** Runs a tool the way the engine does: validate, then run. Throws on invalid arguments. */
export async function callTool(tool: Tool, args: unknown, context: ToolContext) {
  const parsed = tool.parse(args);
  if (!parsed.ok) throw new Error(parsed.error);
  const output = await tool.run(parsed.args, context);
  return typeof output === 'string' ? { output, isError: false } : { isError: false, ...output };
}

export async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Fresh temporary directories, removed after each test. */
export function tempDirFactory(): (prefix?: string) => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    for (const dir of created.splice(0))
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return async (prefix = 'heaw-dir-') => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  };
}
