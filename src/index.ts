// Public library API. It grows milestone by milestone (docs/DESIGN.md §7 and §11).
export { VERSION } from './version.js';

// Config files: import { defineConfig, env } from 'harness-engineered-agentic-workflow'.
export { defineConfig, type DockerWorkspaceConfig, type HeawConfig } from './config/define.js';
export {
  env,
  type EnvRef,
  type ProviderSettings,
  type ProviderType,
  type Setting,
} from './providers/settings.js';
export {
  loadConfig,
  mergeConfigs,
  type LoadConfigOptions,
  type LoadedConfig,
} from './config/load.js';
export { ConfigError } from './config/schema.js';
export { findProjectRoot, heawHome } from './config/project.js';
export { loadInstructions } from './config/instructions.js';
export { formatInstructions, type InstructionFile } from './core/instructions.js';

export {
  createEngine,
  DEFAULT_SYSTEM_PROMPT,
  type AgentRunResult,
  type Engine,
  type EngineOptions,
  type RunAgentOptions,
} from './engine.js';
// An engine set up from the project's config files, as `heaw` does it.
export {
  createProjectEngine,
  inspectProject,
  loadProject,
  NoModelError,
  type Project,
  type ProjectOptions,
} from './project.js';

// Sub-agents and skills (docs/DESIGN.md §4.7, §4.8).
export {
  loadAgentDefinitions,
  parseAgentDefinition,
  parseFrontmatter,
  type AgentDefinition,
  type LoadedDefinitions,
} from './agents/definitions.js';
export {
  DEFAULT_MAX_DEPTH,
  delegateTool,
  type CreateSubagentSession,
  type SubagentSettings,
  type SubagentSpec,
} from './agents/subagents.js';
export {
  formatSkillsIndex,
  loadSkills,
  loadSkillTool,
  SKILL_FOLDERS,
  skillsIn,
  type Skill,
} from './skills/skills.js';
export { BUILT_IN_SKILLS, SETUP_HARNESS_SKILL } from './skills/built-in.js';
export {
  Session,
  DEFAULT_COMPACT_AT,
  DEFAULT_MAX_TURNS,
  type CompactionReport,
  type CompactOptions,
  type SessionOptions,
  type SendOptions,
} from './core/session.js';
export {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type RunLimits,
  type RunResult,
} from './core/loop.js';
export {
  HookRunner,
  type HookAgentResult,
  type HookContext,
  type HookFailure,
  type Hooks,
} from './core/hooks.js';
export { FileChanges, type ChangedRun, type RewindReport } from './core/changes.js';
export { UsageStats, type ToolUsage, type UsageBreakdown } from './core/usage-stats.js';
export { ContextMeter, estimateTokens, SUMMARY_PREFIX, usableWindow } from './core/context.js';

export {
  HOOK_NAMES,
  type ApprovalDecision,
  type EngineEvent,
  type EngineEventBody,
  type EngineEventType,
  type EventBase,
  type HookName,
  type StopReason,
} from './core/events.js';
export type { ApprovalRequest } from './core/tool-execution.js';
export type {
  AgentContext,
  Tool,
  ToolContext,
  ToolKind,
  ToolOutput,
  ToolStatus,
} from './core/tools.js';
export {
  PERMISSION_MODES,
  PermissionPolicy,
  PermissionRuleError,
  PROTECTED_PATHS,
  type PermissionCheck,
  type PermissionMode,
  type PermissionRules,
  type PermissionSummary,
} from './core/permissions.js';
export {
  WorkspaceError,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type RipgrepResult,
  type Workspace,
} from './core/workspace.js';
export { LocalWorkspace } from './workspace/local.js';
export {
  CONTAINER_ROOT,
  DEFAULT_IMAGE,
  DockerWorkspace,
  READ_ONLY_PATHS,
  type DockerOptions,
} from './workspace/docker.js';
export {
  createSessionId,
  restoreSession,
  SessionNotFoundError,
  type RestoredSession,
  type SessionHeader,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './core/session-store.js';
export { JsonlSessionStore } from './sessions/jsonl-store.js';
export { detectShell, type ShellSpec } from './workspace/shell.js';
export { defineTool, type ToolDefinition } from './tools/define.js';
export { DEFAULT_TOOLSETS, TOOLSETS, toolsFor, type ToolsetName } from './tools/index.js';
export { httpRequestTool, type HttpApi } from './tools/http.js';
export { type TodoItem, todoWrite } from './tools/todo.js';
export { webFetch } from './tools/web.js';
export { formatMemory, MEMORY_FILE, readMemory, rememberTool } from './tools/memory.js';

// MCP (docs/DESIGN.md §4.5): engines connect servers from EngineOptions.mcp; these are the parts.
export {
  loadMcpServers,
  readMcpFile,
  removeServerFromFile,
  writeServerToFile,
  PERSONAL_MCP_FILE,
  PROJECT_MCP_FILE,
  type McpHttpServer,
  type McpServerConfig,
  type McpServerEntry,
  type McpServerOptions,
  type McpStdioServer,
} from './mcp/config.js';
export {
  formatMcpInstructions,
  McpManager,
  type McpLoadSummary,
  type McpServerStatus,
} from './mcp/manager.js';
export type { McpConnectionOptions, McpStatus } from './mcp/connection.js';
export {
  loginToMcpServer,
  MCP_CREDENTIALS_DIR,
  McpCredentialStore,
  McpOAuthProvider,
  type McpLogin,
  type McpLoginOptions,
  type McpOAuthSettings,
} from './mcp/oauth.js';
export {
  findRegistryServer,
  planInstall,
  REGISTRY_URL,
  RegistryError,
  searchRegistry,
  suggestName,
  type InstallPlan,
  type InstallVariable,
  type RegistryServer,
  type SkippedInput,
} from './mcp/registry.js';
export {
  textOf,
  toolCallsOf,
  userMessage,
  type AssistantMessage,
  type Message,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolMessage,
  type ToolResultPart,
  type UserMessage,
} from './core/messages.js';
export type {
  FinishReason,
  ModelCapabilities,
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
  ToolSpec,
} from './core/model.js';
export { ModelError, type SerializedError } from './core/errors.js';
export { addUsage, costOf, emptyUsage, type ModelPricing, type Usage } from './core/usage.js';
export { capabilitiesFor, pricingFor } from './providers/catalog.js';

export {
  normalizeAzureEndpoint,
  parseModelSpec,
  PROVIDER_NAMES,
  ProviderConfigError,
  resolveModel,
  type Env,
  type ResolveModelOptions,
} from './providers/registry.js';
export { ScriptedModelClient, type ScriptedResponse } from './providers/scripted.js';

// Observability and evals (docs/DESIGN.md §4.14, §4.16).
export { Redactor, referencedVariables, secretsFromEnv } from './core/redact.js';
export { OtelTracer, telemetryFromEnv, type TelemetryOptions } from './observability/otel.js';
export { loadEvalCases, parseEvalCase, type EvalCase, type EvalCheck } from './evals/cases.js';
export { compareReports, type CaseComparison } from './evals/compare.js';
export {
  formatEvalReport,
  judgeCost,
  parseVerdict,
  runEvals,
  type CaseResult,
  type CheckResult,
  type EvalReport,
  type RunEvalsOptions,
  type TrialResult,
} from './evals/runner.js';
