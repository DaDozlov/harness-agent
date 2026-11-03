import { type PermissionMode, PermissionRuleError } from '../core/permissions.js';
import { SessionNotFoundError } from '../core/session-store.js';
import { ConfigError } from '../config/schema.js';
import { loadProject, NoModelError, type Project } from '../project.js';
import { type Env, ProviderConfigError } from '../providers/registry.js';

export { NoModelError };

/** Flags shared by the chat, `resume` and `run`. */
export interface AgentFlags {
  model?: string;
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  /** `false` with `--no-tools`. */
  tools?: boolean;
  /** `false` with `--no-save`. */
  save?: boolean;
  maxTurns?: number;
  maxCost?: number;
  maxMinutes?: number;
  /** `--intent`: what the session is for. */
  intent?: string;
}

export interface SetupContext {
  cwd: string;
  env: Env;
  interactive: boolean;
  /** See `LoadConfigOptions.packageEntry`. */
  packageEntry?: string | undefined;
}

/** Turns flags, environment and config files into engine options (see `loadProject`). */
export async function setupEngine(flags: AgentFlags, context: SetupContext): Promise<Project> {
  const { maxTurns, maxCost, maxMinutes, ...overrides } = flags;
  return loadProject({
    ...context,
    ...overrides,
    limits: { maxTurns, maxCostUsd: maxCost, maxMinutes },
  });
}

/** The message for a problem the user can fix (config, credentials, rules), or undefined for a bug. */
export function userFacingMessage(error: unknown): string | undefined {
  const fixable = [
    ConfigError,
    ProviderConfigError,
    PermissionRuleError,
    NoModelError,
    SessionNotFoundError,
  ];
  return fixable.some((type) => error instanceof type) ? (error as Error).message : undefined;
}
