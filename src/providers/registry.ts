import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelCapabilities, ModelClient } from '../core/model.js';
import { AiSdkModelClient } from './ai-sdk.js';
import { capabilitiesFor } from './catalog.js';
import {
  PROVIDER_TYPES,
  ProviderConfigError,
  type ProviderSettings,
  type ProviderType,
  resolveSetting,
  type Setting,
} from './settings.js';

export { ProviderConfigError } from './settings.js';

export type Env = Record<string, string | undefined>;

export interface ResolveModelOptions {
  /** Where credentials are read from. Default: `process.env`. */
  env?: Env;
  /** Custom fetch, e.g. for a proxy or to inspect requests in tests. */
  fetch?: typeof globalThis.fetch;
  /** Provider settings from config, by provider name. */
  providers?: Record<string, ProviderSettings>;
  /** Corrections to what the catalog knows about the model, e.g. its context window. */
  capabilities?: Partial<ModelCapabilities>;
}

/** What a provider factory gets: the model id and a way to read settings with fallbacks. */
interface FactoryInput {
  modelId: string;
  /** The provider name from the model string, e.g. `azure` or `azure-eu`. */
  name: string;
  settings: ProviderSettings;
  fetch: typeof globalThis.fetch | undefined;
  /**
   * A setting from config, else (for built-in provider names only) the first environment
   * variable that is set. Custom names never fall back to environment variables, so a second
   * Azure resource cannot pick up the first one's key by accident.
   */
  read: (key: SettingKey, ...envNames: string[]) => string | undefined;
  /** An environment variable, for built-in provider names only. */
  fromEnv: (envName: string) => string | undefined;
  headers: () => Record<string, string> | undefined;
}

type SettingKey = 'apiKey' | 'baseURL' | 'endpoint' | 'resourceName';
type ProviderFactory = (input: FactoryInput) => Promise<LanguageModelV4>;

const DISPLAY_NAMES: Record<ProviderType, string> = {
  openai: 'OpenAI',
  azure: 'Azure OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible provider',
};

// Provider packages are imported on first use, so only the provider you use is loaded.
const FACTORIES: Record<ProviderType, ProviderFactory> = {
  async openai(input) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    return createOpenAI({
      apiKey: requireValue(input, 'apiKey', 'OPENAI_API_KEY'),
      baseURL: input.read('baseURL', 'OPENAI_BASE_URL'),
      headers: input.headers(),
      fetch: input.fetch,
    })(input.modelId);
  },
  async azure(input) {
    const { createAzure } = await import('@ai-sdk/azure');
    const apiKey = requireValue(input, 'apiKey', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY');
    const endpoint = input.read('endpoint', 'AZURE_OPENAI_ENDPOINT');
    const resourceName = input.read('resourceName', 'AZURE_RESOURCE_NAME');
    if (!endpoint && !resourceName) {
      throw new ProviderConfigError(
        input.name === 'azure'
          ? 'Azure OpenAI needs an endpoint. Set AZURE_OPENAI_ENDPOINT, e.g. ' +
              'https://my-resource.openai.azure.com (or set AZURE_RESOURCE_NAME).'
          : `Provider "${input.name}" needs an endpoint: set providers.${input.name}.endpoint in heaw.config.ts.`,
      );
    }
    const provider = createAzure({
      apiKey,
      headers: input.headers(),
      fetch: input.fetch,
      ...(endpoint ? { baseURL: normalizeAzureEndpoint(endpoint) } : { resourceName }),
    });
    return azureModel(provider, input, input.settings.api ?? input.fromEnv('AZURE_OPENAI_API'));
  },
  async anthropic(input) {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    return createAnthropic({
      apiKey: requireValue(input, 'apiKey', 'ANTHROPIC_API_KEY'),
      baseURL: input.read('baseURL', 'ANTHROPIC_BASE_URL'),
      headers: input.headers(),
      fetch: input.fetch,
    })(input.modelId);
  },
  async google(input) {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    return createGoogleGenerativeAI({
      apiKey: requireValue(input, 'apiKey', 'GOOGLE_GENERATIVE_AI_API_KEY'),
      baseURL: input.read('baseURL'),
      headers: input.headers(),
      fetch: input.fetch,
    })(input.modelId);
  },
  async ollama(input) {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    return createOpenAICompatible({
      name: input.name,
      baseURL: input.read('baseURL', 'OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1',
      headers: input.headers(),
      fetch: input.fetch,
      // Without it, a streamed answer reports no tokens: no usage, no context calibration.
      includeUsage: true,
    }).chatModel(input.modelId);
  },
  async 'openai-compatible'(input) {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const baseURL = input.read('baseURL');
    if (!baseURL) {
      throw new ProviderConfigError(
        `Provider "${input.name}" needs a base URL: set providers.${input.name}.baseURL in heaw.config.ts.`,
      );
    }
    return createOpenAICompatible({
      name: input.name,
      baseURL,
      apiKey: input.read('apiKey'),
      headers: input.headers(),
      fetch: input.fetch,
    }).chatModel(input.modelId);
  },
};

/** Provider names that work without configuration. */
export const PROVIDER_NAMES: readonly string[] = PROVIDER_TYPES.filter(
  (type) => type !== 'openai-compatible',
);

/** Creates a model client from a `provider:model` string, with settings from config and `env`. */
export async function resolveModel(
  spec: string,
  options: ResolveModelOptions = {},
): Promise<ModelClient> {
  const { provider: name, modelId } = parseModelSpec(spec);
  const environment = options.env ?? process.env;
  const settings = options.providers?.[name] ?? {};
  const builtIn = PROVIDER_NAMES.includes(name);
  const type = settings.type ?? (builtIn ? (name as ProviderType) : undefined);
  if (!type) {
    const configured = Object.keys(options.providers ?? {});
    throw new ProviderConfigError(
      `Unknown provider "${name}" in "${spec}". Available: ${[...PROVIDER_NAMES, ...configured].join(', ')}. ` +
        'Other providers can be added under providers in heaw.config.ts.',
    );
  }
  if (!Object.hasOwn(FACTORIES, type)) {
    throw new ProviderConfigError(
      `providers.${name}.type must be one of ${PROVIDER_TYPES.join(', ')}, not "${String(type)}".`,
    );
  }

  const where = (key: string) => `providers.${name}.${key} in heaw.config.ts`;
  const fromEnv = (envName: string) =>
    builtIn ? environment[envName]?.trim() || undefined : undefined;
  const model = await FACTORIES[type]({
    modelId,
    name,
    settings,
    fetch: options.fetch,
    read: (key, ...envNames) =>
      resolveSetting(settings[key], environment, where(key)) ?? envNames.map(fromEnv).find(Boolean),
    fromEnv,
    headers: () => resolveHeaders(settings.headers, environment, where('headers')),
  });
  return new AiSdkModelClient(`${name}:${modelId}`, model, {
    ...capabilitiesFor(modelId),
    ...options.capabilities,
  });
}

function azureModel(
  provider: Awaited<ReturnType<typeof import('@ai-sdk/azure').createAzure>>,
  input: FactoryInput,
  api: string | undefined,
): LanguageModelV4 {
  const flavour = api ?? 'responses';
  if (flavour === 'responses') return provider.responses(input.modelId);
  if (flavour === 'chat') return provider.chat(input.modelId);
  throw new ProviderConfigError(
    input.name === 'azure' && !input.settings.api
      ? `AZURE_OPENAI_API must be "responses" or "chat", not "${flavour}".`
      : `providers.${input.name}.api must be "responses" or "chat", not "${flavour}".`,
  );
}

function requireValue(input: FactoryInput, key: SettingKey, ...envNames: string[]): string {
  const value = input.read(key, ...envNames);
  if (value) return value;
  const type = input.settings.type ?? (input.name as ProviderType);
  throw new ProviderConfigError(
    PROVIDER_NAMES.includes(input.name) && envNames.length
      ? `${DISPLAY_NAMES[type]} needs an API key. Set ${envNames[0]} in your environment or in a .env file.`
      : `Provider "${input.name}" needs an API key: set providers.${input.name}.${key} in heaw.config.ts, e.g. env('MY_KEY').`,
  );
}

function resolveHeaders(
  headers: Record<string, Setting> | undefined,
  environment: Env,
  where: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      resolveSetting(value, environment, `${where}.${key}`) ?? '',
    ]),
  );
}

/** Splits at the first colon only: model ids may contain colons (`ollama:llama3.1:8b`). */
export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const index = spec.indexOf(':');
  const provider = spec.slice(0, index).trim().toLowerCase();
  const modelId = spec.slice(index + 1).trim();
  if (index === -1 || !provider || !modelId) {
    throw new ProviderConfigError(
      `Invalid model "${spec}". Use provider:model, e.g. azure:my-deployment or openai:gpt-5.`,
    );
  }
  return { provider, modelId };
}

/**
 * Azure shows several URL forms (resource endpoint, full "target URI" of a deployment, v1
 * endpoint). All of them are reduced to the base URL the Azure provider expects.
 */
export function normalizeAzureEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new ProviderConfigError(`The Azure endpoint is not a valid URL: "${endpoint}".`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const lower = path.toLowerCase();
  const v1 = lower.indexOf('/openai/v1');
  const openai = lower.indexOf('/openai');
  let base: string;
  if (v1 !== -1) base = path.slice(0, v1 + '/openai/v1'.length);
  else if (openai !== -1) base = path.slice(0, openai + '/openai'.length);
  else if (path === '') base = '/openai';
  else base = path; // e.g. a Foundry project endpoint: /api/projects/<name>
  return `${url.origin}${base}`;
}
