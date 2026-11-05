import { z } from 'zod';
import { unknownPriceMessage } from './core/loop.js';
import type { ModelClient } from './core/model.js';
import { PermissionPolicy } from './core/permissions.js';
import type { Tool } from './core/tools.js';
import type { EngineOptions } from './engine.js';
import { resolveModel, type Env } from './providers/registry.js';
import { defineTool } from './tools/define.js';

/**
 * `check_config`: loads the project's harness as heaw would (config files, rules, the model and
 * its credentials, MCP servers, agents, skills) and reports what is wrong, or what it set up. The
 * `setup-harness` skill calls it before handing over, so a broken config never waits for the
 * next start to show up.
 */
export function checkConfigTool(inspect: () => Promise<string>): Tool {
  return defineTool({
    name: 'check_config',
    description:
      "Check this project's heaw setup (heaw.config.ts, .mcp.json, AGENTS.md, agents, skills) " +
      'as heaw would load it: reports problems to fix, or a summary of what is configured. Call ' +
      'it after changing any of these files.',
    kind: 'read',
    parameters: z.object({}),
    run: () => inspect(),
  });
}

/** What a loaded project sets up, or the first problem that stops it from loading. */
export async function describeLoadedProject(
  load: () => Promise<{ options: EngineOptions; warnings: string[] }>,
  env: Env,
): Promise<string> {
  let project: { options: EngineOptions; warnings: string[] };
  try {
    project = await load();
  } catch (error) {
    return problem(error);
  }
  const { options } = project;
  try {
    new PermissionPolicy(options.permissions);
    const model = typeof options.model === 'string' ? await resolve(options, env) : options.model;
    return summary(options, model, project.warnings);
  } catch (error) {
    return problem(error);
  } finally {
    await options.workspace?.dispose();
  }
}

async function resolve(options: EngineOptions, env: Env): Promise<ModelClient> {
  const spec = options.model as string;
  const model = await resolveModel(spec, {
    env,
    providers: options.providers,
    capabilities: options.models?.[spec],
  });
  if (options.limits?.maxCostUsd !== undefined && !model.capabilities.pricing) {
    throw new Error(unknownPriceMessage(model.id));
  }
  return model;
}

function problem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `The configuration does not load. Fix this, then check again:\n${message}`;
}

function summary(options: EngineOptions, model: ModelClient, warnings: string[]): string {
  const rules = options.permissions ?? {};
  const list = (items: readonly string[] | undefined) =>
    items?.length ? items.join(', ') : 'none';
  const limits = Object.entries(options.limits ?? {})
    .map(([name, value]) => `${name} ${String(value)}`)
    .join(', ');
  const hooks = [...new Set([options.hooks ?? []].flat().flatMap((set) => Object.keys(set)))];
  const servers = options.mcp?.servers.map((server) => server.name) ?? [];
  const workspace = options.workspace;
  const lines = [
    'The configuration loads.',
    `- Model: ${model.id}${model.capabilities.pricing ? '' : ' (price unknown: costs are not shown)'}`,
    `- Permissions: ${rules.mode ?? 'default'} mode; allow ${list(rules.allow)}; ask ${list(rules.ask)}; deny ${list(rules.deny)}`,
    `- Limits: ${limits || 'defaults (100 turns per task)'}`,
    `- Checks before finishing: ${hooks.length ? `hooks ${hooks.join(', ')}` : 'no hooks (heaw reminds the agent to verify unchecked changes)'}`,
    `- Workspace: ${workspace ? `${workspace.kind}${workspace.description ? ` (${workspace.description.split('.')[0]})` : ''}` : 'local'}`,
    `- MCP servers: ${servers.length ? `${servers.join(', ')} (they connect when heaw starts; OAuth ones need heaw mcp login <name>)` : 'none'}`,
    `- Instructions: ${list(options.instructions?.map((file) => file.source))}`,
    `- Agents: ${list(options.agents?.map((agent) => agent.name))}; skills: ${list(options.skills?.map((skill) => skill.name))}`,
    ...(options.telemetry ? [`- Traces: ${options.telemetry.endpoint}`] : []),
    ...warnings.map((warning) => `- Warning: ${warning}`),
    'The chat applies it before the next message (heaw run: on its next start).',
  ];
  return lines.join('\n');
}
