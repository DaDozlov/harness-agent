import type { SubagentSettings } from '../agents/subagents.js';
import type { Hooks } from '../core/hooks.js';
import type { ModelCapabilities } from '../core/model.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { PermissionRules } from '../core/permissions.js';
import type { Tool } from '../core/tools.js';
import type { ProviderSettings, Setting } from '../providers/settings.js';
import type { HttpApi } from '../tools/http.js';
import type { ToolsetName } from '../tools/index.js';

/**
 * Settings in `heaw.config.ts` (project) or `~/.heaw/config.ts` (personal, applies to every
 * project). docs/DESIGN.md §5.
 */
export interface HeawConfig {
  /** `provider:model`, e.g. `azure:my-deployment`. `--model` and `HEAW_MODEL` take precedence. */
  model?: string;
  /** Provider settings by name, e.g. an Azure endpoint, or a custom OpenAI-compatible server. */
  providers?: Record<string, ProviderSettings>;
  /** Corrections to what heaw knows about a model, by model string, e.g. its context window. */
  models?: Record<string, Partial<ModelCapabilities>>;
  /** Where tools act (docs/DESIGN.md §4.12). */
  workspace?: {
    /** `local` (default): on this machine. `docker`: commands run in a container. */
    type?: 'local' | 'docker';
    /** Local: the shell for run_command, e.g. `pwsh` or a path to bash. `HEAW_SHELL` takes precedence. */
    shell?: string;
  } & DockerWorkspaceConfig;
  /** Built-in toolsets. Default: all of them (`http` only does something with `http.apis`). */
  toolsets?: ToolsetName[];
  /** Your own tools, created with `defineTool`. */
  tools?: Tool[];
  /** Personal and project rules are combined; the project's mode wins. */
  permissions?: Omit<PermissionRules, 'preapproved'>;
  /** Per message (run). A run that reaches one stops and says which. */
  limits?: {
    /** Model turns. Default: 100. */
    maxTurns?: number;
    /** Tokens billed: input plus output, summed over the run's model calls. */
    maxTokens?: number;
    /** Cost in USD. Needs the model's prices (built in for some models, or `models[…].pricing`). */
    maxCostUsd?: number;
    /** Wall-clock minutes, waiting for approvals included. */
    maxMinutes?: number;
  };
  context?: {
    /** Compact when a request would fill this share of the context window. Default: 0.8. */
    compactAt?: number | false;
  };
  /**
   * Functions run at fixed points (docs/DESIGN.md §4.11), e.g. `beforeStop` to run the tests
   * before the agent may finish. Personal and project hooks both run, personal first.
   */
  hooks?: Hooks | Hooks[];
  /**
   * When a run changed files and ran no command after its last change, the agent is sent back
   * once to check its work (tests, linter, build). Default: true, unless a `beforeStop` hook is
   * configured, which checks in its own way.
   */
  verifyChanges?: boolean;
  /** How hard models that reason think: low, medium or high. Default: the provider's. `/plan` uses high. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Sub-agents started with `delegate` (agents are defined in `.heaw/agents/*.md`): how deep
   * they may nest (default 1: sub-agents cannot start their own), how many run at once (4), and
   * the limits of each one whose definition sets none (50 turns).
   */
  subagents?: SubagentSettings;
  /**
   * OpenTelemetry traces over OTLP/HTTP, e.g. to Jaeger, Langfuse or Phoenix. The standard
   * variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, …) take precedence.
   */
  telemetry?: {
    endpoint?: string;
    headers?: Record<string, Setting>;
    serviceName?: string;
    /** Also record prompts, answers and tool arguments and results (secrets are redacted). */
    captureContent?: boolean;
  };
  /** MCP servers, in the same shape as `.mcp.json`; secrets with `env('NAME')`. */
  mcpServers?: Record<string, McpServerConfig>;
  http?: {
    /**
     * APIs the agent may call with `http_request`, by base URL, e.g.
     * `{ 'https://api.example.com/v1': { headers: { Authorization: env('EXAMPLE_TOKEN') } } }`.
     */
    apis?: Record<string, HttpApi>;
  };
  sessions?: {
    /** Save conversations in `.heaw/sessions/`. Default: true. */
    save?: boolean;
  };
}

/** `workspace` settings for `type: 'docker'`. */
export interface DockerWorkspaceConfig {
  /** The image commands run in; it needs `sh`. Default: `node:24`. */
  image?: string;
  /** `none` (default): commands get no network. `bridge` for package installs and `git push`. */
  network?: string;
  /** Limits as `docker run` takes them, e.g. `2` and `'4g'`. */
  cpus?: number | string;
  memory?: string;
  /** The only variables commands in the container get, e.g. `{ GH_TOKEN: env('GITHUB_TOKEN') }`. */
  env?: Record<string, Setting>;
  /** HTTPS `git push` with the token in `tokenEnv` (one of `env`). The commit author is copied from the host. */
  git?: { tokenEnv?: string; username?: string };
  /** The container CLI. Default: `docker`; `podman` works too. */
  command?: string;
}

/** Identity function that gives `heaw.config.ts` type checking and editor completion. */
export function defineConfig(config: HeawConfig): HeawConfig {
  return config;
}
