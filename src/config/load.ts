import { createJiti } from 'jiti';
import type { HeawConfig } from './define.js';
import { CONFIG_FILES, findFile, findProjectRoot, heawHome } from './project.js';
import { ConfigError, validateConfig } from './schema.js';

export interface LoadedConfig {
  /** Personal and project settings combined. */
  config: HeawConfig;
  /** The config files that were loaded, personal first. */
  files: string[];
  projectRoot: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** The user's home directory, for finding the project root. */
  userHome?: string;
  /**
   * Where `import ... from 'harness-engineered-agentic-workflow'` in a config file points. A
   * globally installed heaw passes itself, so projects need not install the package.
   */
  packageEntry?: string;
}

const PERSONAL_FILES = ['config.ts', 'config.mts', 'config.js', 'config.mjs'];

/** Finds the project, then loads `~/.heaw/config.ts` and the project's `heaw.config.ts`. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const projectRoot = findProjectRoot(options.cwd ?? process.cwd(), options.userHome);
  const files = [
    findFile(heawHome(env), PERSONAL_FILES),
    findFile(projectRoot, CONFIG_FILES),
  ].filter((file): file is string => file !== undefined);

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    interopDefault: true,
    ...(options.packageEntry && {
      alias: { 'harness-engineered-agentic-workflow': options.packageEntry },
    }),
  });

  let config: HeawConfig = {};
  for (const file of files) {
    let exported: unknown;
    try {
      exported = await jiti.import(file, { default: true });
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new ConfigError(`Could not load ${file}: ${message}`);
    }
    config = mergeConfigs(config, validateConfig(exported, file));
  }
  return { config, files, projectRoot };
}

/** Project settings override personal ones; permission rules and tools are combined. */
export function mergeConfigs(base: HeawConfig, override: HeawConfig): HeawConfig {
  const merged: HeawConfig = { ...base, ...override };
  if (base.providers || override.providers)
    merged.providers = { ...base.providers, ...override.providers };
  if (base.models || override.models) merged.models = { ...base.models, ...override.models };
  if (base.mcpServers || override.mcpServers) {
    merged.mcpServers = { ...base.mcpServers, ...override.mcpServers };
  }
  if (base.http || override.http) {
    merged.http = { apis: { ...base.http?.apis, ...override.http?.apis } };
  }
  if (base.workspace || override.workspace)
    merged.workspace = { ...base.workspace, ...override.workspace };
  if (base.limits || override.limits) merged.limits = { ...base.limits, ...override.limits };
  if (base.context || override.context) merged.context = { ...base.context, ...override.context };
  if (base.subagents || override.subagents) {
    merged.subagents = {
      ...base.subagents,
      ...override.subagents,
      limits: { ...base.subagents?.limits, ...override.subagents?.limits },
    };
  }
  if (base.hooks || override.hooks) {
    merged.hooks = [...[base.hooks ?? []].flat(), ...[override.hooks ?? []].flat()];
  }
  if (base.sessions || override.sessions)
    merged.sessions = { ...base.sessions, ...override.sessions };
  if (base.tools || override.tools)
    merged.tools = [...(base.tools ?? []), ...(override.tools ?? [])];
  if (base.permissions || override.permissions) {
    const combine = (key: 'allow' | 'ask' | 'deny') => [
      ...(base.permissions?.[key] ?? []),
      ...(override.permissions?.[key] ?? []),
    ];
    const mode = override.permissions?.mode ?? base.permissions?.mode;
    merged.permissions = {
      ...(mode && { mode }),
      allow: combine('allow'),
      ask: combine('ask'),
      deny: combine('deny'),
    };
  }
  return merged;
}
