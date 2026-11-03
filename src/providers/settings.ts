/** A reference to an environment variable, created with `env()` in a config file. */
export interface EnvRef {
  readonly kind: 'env';
  readonly name: string;
  readonly prefix: string;
}

/** A setting written in config: plain text, or `env('NAME')` for anything secret. */
export type Setting = string | EnvRef;

/**
 * Reads a value from the environment when it is needed, so config files never contain secrets.
 * `prefix` is prepended, e.g. `env('TOKEN', { prefix: 'Bearer ' })` for an Authorization header.
 */
export function env(name: string, options: { prefix?: string } = {}): EnvRef {
  return { kind: 'env', name, prefix: options.prefix ?? '' };
}

export function isEnvRef(value: unknown): value is EnvRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EnvRef).kind === 'env' &&
    typeof (value as EnvRef).name === 'string'
  );
}

/** Provider types heaw can create. */
export const PROVIDER_TYPES = [
  'openai',
  'azure',
  'anthropic',
  'google',
  'ollama',
  'openai-compatible',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Settings for one provider in `heaw.config.ts`. The key is the provider name used in model
 * strings (`azure:my-deployment`). Built-in names need no `type`; other names (`azure-eu`,
 * `lmstudio`) say which kind of provider they are. Unset values fall back to the usual
 * environment variables.
 */
export interface ProviderSettings {
  type?: ProviderType;
  apiKey?: Setting;
  /** OpenAI, Anthropic, Ollama and OpenAI-compatible providers. Required for openai-compatible. */
  baseURL?: Setting;
  /** Azure: the resource endpoint or a deployment's target URI. */
  endpoint?: Setting;
  /** Azure: used when no endpoint is set. */
  resourceName?: Setting;
  /** Azure: which API to call. Default: responses. */
  api?: 'responses' | 'chat';
  /** Extra HTTP headers, e.g. for a gateway. */
  headers?: Record<string, Setting>;
}

/**
 * A model can't be created because of missing or invalid settings, e.g. an unset environment
 * variable. The message says how to fix it.
 */
export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

/**
 * The value of a setting. `where` names the setting in error messages, e.g.
 * `providers.azure.apiKey`. Returns undefined for an unset setting or an empty variable.
 */
export function resolveSetting(
  value: Setting | undefined,
  environment: Record<string, string | undefined>,
  where: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const resolved = environment[value.name]?.trim();
  if (!resolved) {
    throw new ProviderConfigError(
      `${where} reads the environment variable ${value.name}, which is not set. Set it in your environment or in .env.`,
    );
  }
  return value.prefix + resolved;
}
