import { z } from 'zod';
import { HOOK_NAMES, type HookName } from '../core/events.js';
import { PERMISSION_MODES } from '../core/permissions.js';
import type { Tool } from '../core/tools.js';
import { type EnvRef, isEnvRef, PROVIDER_TYPES } from '../providers/settings.js';
import { TOOLSETS } from '../tools/index.js';
import type { HeawConfig } from './define.js';
import { ConfigError } from './errors.js';

// One check, not a union: a union's error is only "Invalid input".
const setting = z.custom<string | EnvRef>((value) => typeof value === 'string' || isEnvRef(value), {
  message: "expected text or env('NAME')",
});

const provider = z
  .object({
    type: z.enum(PROVIDER_TYPES).optional(),
    apiKey: setting.optional(),
    baseURL: setting.optional(),
    endpoint: setting.optional(),
    resourceName: setting.optional(),
    api: z.enum(['responses', 'chat']).optional(),
    headers: z.record(z.string(), setting).optional(),
  })
  .strict();

const capabilities = z
  .object({
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    toolCalling: z.boolean(),
    parallelToolCalls: z.boolean(),
    vision: z.boolean(),
    reasoning: z.boolean(),
    promptCaching: z.boolean(),
    pricing: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative().optional(),
        cacheWrite: z.number().nonnegative().optional(),
      })
      .strict(),
  })
  .partial()
  .strict();

const hookFunction = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === 'function',
  { message: 'expected a function' },
);
const hookSet = z
  .object(
    Object.fromEntries(HOOK_NAMES.map((name) => [name, hookFunction.optional()])) as Record<
      HookName,
      z.ZodOptional<typeof hookFunction>
    >,
  )
  .strict();

const tool = z.custom<Tool>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Tool).name === 'string' &&
    typeof (value as Tool).run === 'function' &&
    typeof (value as Tool).parse === 'function',
  { message: 'expected a tool created with defineTool' },
);

const rules = z.array(z.string()).optional();

const limits = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxMinutes: z.number().positive().optional(),
  })
  .strict();

const configSchema = z
  .object({
    model: z.string().min(1).optional(),
    providers: z.record(z.string(), provider).optional(),
    models: z.record(z.string(), capabilities).optional(),
    workspace: z
      .object({
        type: z.enum(['local', 'docker']).optional(),
        shell: z.string().min(1).optional(),
        image: z.string().min(1).optional(),
        network: z.string().min(1).optional(),
        cpus: z.number().positive().or(z.string().min(1)).optional(),
        memory: z.string().min(1).optional(),
        env: z
          .record(z.string().regex(/^[A-Za-z_]\w*$/, 'expected a variable name'), setting)
          .optional(),
        git: z
          .object({
            tokenEnv: z
              .string()
              .regex(/^[A-Za-z_]\w*$/, 'expected a variable name')
              .optional(),
            username: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        command: z.string().min(1).optional(),
      })
      .strict()
      // Settings for the other kind of workspace would be ignored silently; say so instead.
      .superRefine((workspace, context) => {
        const docker = workspace.type === 'docker';
        for (const key of Object.keys(workspace)) {
          if (key === 'type') continue;
          if (docker && key === 'shell') {
            context.addIssue({
              code: 'custom',
              path: [key],
              message: "only for type 'local'; the container runs bash, or sh when it has no bash",
            });
          } else if (!docker && key !== 'shell') {
            context.addIssue({
              code: 'custom',
              path: [key],
              message: "only used with type: 'docker'",
            });
          }
        }
      })
      .optional(),
    toolsets: z.array(z.enum(Object.keys(TOOLSETS) as [string, ...string[]])).optional(),
    tools: z.array(tool).optional(),
    permissions: z
      .object({ mode: z.enum(PERMISSION_MODES).optional(), allow: rules, ask: rules, deny: rules })
      .strict()
      .optional(),
    limits: limits.optional(),
    telemetry: z
      .object({
        endpoint: z.url({ protocol: /^https?$/ }).optional(),
        headers: z.record(z.string(), setting).optional(),
        serviceName: z.string().min(1).optional(),
        captureContent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        maxDepth: z.number().int().min(0).max(5).optional(),
        maxParallel: z.number().int().min(1).max(16).optional(),
        limits: limits.optional(),
      })
      .strict()
      .optional(),
    context: z
      .object({ compactAt: z.union([z.number().gt(0).max(1), z.literal(false)]).optional() })
      .strict()
      .optional(),
    // One set or several. Checked by hand: a union's error is only "Invalid input".
    hooks: z
      .unknown()
      .superRefine((value, context) => {
        const sets = Array.isArray(value) ? value : [value];
        for (const [index, set] of sets.entries()) {
          const result = hookSet.safeParse(set);
          for (const issue of result.error?.issues ?? []) {
            const at = Array.isArray(value) ? [index, ...issue.path] : issue.path;
            context.addIssue({ ...issue, path: at });
          }
        }
      })
      .optional(),
    verifyChanges: z.boolean().optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    sessions: z.object({ save: z.boolean().optional() }).strict().optional(),
    // Checked in detail when servers load, with messages that name the server.
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    http: z
      .object({
        apis: z
          .record(
            z.string(),
            z
              .object({
                headers: z.record(z.string(), setting).optional(),
                description: z.string().optional(),
              })
              .strict(),
          )
          // A key schema's message is lost ("Invalid key in record"), so keys are checked here.
          .superRefine((apis, context) => {
            for (const key of Object.keys(apis)) {
              if (isHttpUrl(key)) continue;
              context.addIssue({
                code: 'custom',
                path: [key],
                message: 'expected a base URL such as https://api.example.com',
              });
            }
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Settings that arrive with later milestones, so a premature config gets a useful message. */
const PLANNED: Record<string, string> = {};

export { ConfigError };

export function validateConfig(value: unknown, file: string): HeawConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `${file} must export a config object: export default defineConfig({ ... }).`,
    );
  }
  const result = configSchema.safeParse(value);
  if (result.success) return result.data as HeawConfig;

  const problems = result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => {
        const where = [...issue.path, key].join('.');
        const planned = issue.path.length === 0 ? PLANNED[key] : undefined;
        return planned
          ? `${where}: ${planned} are not supported yet in this version of heaw.`
          : `${where}: unknown setting.`;
      });
    }
    return [`${issue.path.join('.') || '(config)'}: ${issue.message}`];
  });
  throw new ConfigError(
    `${file} has invalid settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
}
