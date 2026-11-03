import { describe, expect, it } from 'vitest';
import { capabilitiesFor, DEFAULT_CAPABILITIES } from '../../src/providers/catalog.js';
import {
  normalizeAzureEndpoint,
  parseModelSpec,
  ProviderConfigError,
  resolveModel,
} from '../../src/providers/registry.js';
import { env } from '../../src/providers/settings.js';

const AZURE_ENV = {
  AZURE_OPENAI_API_KEY: 'test-key',
  AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com/',
};

/** Records the request a provider would send, then fails it, so no network is used. */
function capturingFetch() {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return Promise.reject(new Error('stop: request captured'));
  };
  return { fetch, requests };
}

async function firstRequestOf(spec: string, env: Record<string, string>) {
  const { fetch, requests } = capturingFetch();
  const client = await resolveModel(spec, { env, fetch });
  const stream = client.stream({ system: '', messages: [] })[Symbol.asyncIterator]();
  await expect(stream.next()).rejects.toThrow();
  return requests[0]!;
}

describe('parseModelSpec', () => {
  it('splits provider and model at the first colon', () => {
    expect(parseModelSpec('azure:my-gpt5')).toEqual({ provider: 'azure', modelId: 'my-gpt5' });
    expect(parseModelSpec('ollama:llama3.1:8b')).toEqual({
      provider: 'ollama',
      modelId: 'llama3.1:8b',
    });
    expect(parseModelSpec('OpenAI:gpt-5')).toEqual({ provider: 'openai', modelId: 'gpt-5' });
  });

  it.each(['gpt-5', ':gpt-5', 'azure:', ''])('rejects "%s"', (spec) => {
    expect(() => parseModelSpec(spec)).toThrow(ProviderConfigError);
  });
});

describe('normalizeAzureEndpoint', () => {
  it.each([
    ['https://res.openai.azure.com/', 'https://res.openai.azure.com/openai'],
    ['https://res.openai.azure.com', 'https://res.openai.azure.com/openai'],
    ['https://res.openai.azure.com/openai/v1/', 'https://res.openai.azure.com/openai/v1'],
    [
      'https://res.cognitiveservices.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2025-01-01-preview',
      'https://res.cognitiveservices.azure.com/openai',
    ],
    [
      'https://res.openai.azure.com/openai/responses?api-version=2025-04-01-preview',
      'https://res.openai.azure.com/openai',
    ],
    [
      'https://res.services.ai.azure.com/api/projects/my-project',
      'https://res.services.ai.azure.com/api/projects/my-project',
    ],
  ])('%s → %s', (endpoint, expected) => {
    expect(normalizeAzureEndpoint(endpoint)).toBe(expected);
  });

  it('rejects something that is not a URL', () => {
    expect(() => normalizeAzureEndpoint('my-resource')).toThrow(ProviderConfigError);
  });
});

describe('resolveModel', () => {
  it('creates an Azure model with capabilities from the catalog', async () => {
    const custom = await resolveModel('azure:my-deployment', { env: AZURE_ENV });
    const known = await resolveModel('azure:gpt-5-mini', { env: AZURE_ENV });

    expect(custom.id).toBe('azure:my-deployment');
    expect(custom.capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(known.capabilities.contextWindow).toBe(400_000);
  });

  it('calls the Azure v1 Responses API with the deployment name and API key', async () => {
    const request = await firstRequestOf('azure:my-deployment', AZURE_ENV);

    expect(request.url).toMatch(
      /^https:\/\/my-resource\.openai\.azure\.com\/openai\/v1\/responses/,
    );
    expect(request.headers.get('api-key')).toBe('test-key');
  });

  it('accepts a full deployment target URI and the chat completions API', async () => {
    const request = await firstRequestOf('azure:my-deployment', {
      ...AZURE_ENV,
      AZURE_OPENAI_ENDPOINT:
        'https://res.cognitiveservices.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2025-01-01-preview',
      AZURE_OPENAI_API: 'chat',
    });

    expect(request.url).toMatch(
      /^https:\/\/res\.cognitiveservices\.azure\.com\/openai\/v1\/chat\/completions/,
    );
  });

  it('also reads the AI SDK variable names', async () => {
    const client = await resolveModel('azure:dep', {
      env: { AZURE_API_KEY: 'key', AZURE_RESOURCE_NAME: 'my-resource' },
    });
    expect(client.id).toBe('azure:dep');
  });

  it('explains a missing Azure key or endpoint', async () => {
    await expect(
      resolveModel('azure:dep', { env: { AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com' } }),
    ).rejects.toThrow(/AZURE_OPENAI_API_KEY/);
    await expect(
      resolveModel('azure:dep', { env: { AZURE_OPENAI_API_KEY: 'key' } }),
    ).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
  });

  it('rejects an unknown Azure API flavour', async () => {
    await expect(
      resolveModel('azure:dep', { env: { ...AZURE_ENV, AZURE_OPENAI_API: 'completions' } }),
    ).rejects.toThrow(/"responses" or "chat"/);
  });

  it('lists the available providers for an unknown one', async () => {
    await expect(resolveModel('nope:model', { env: {} })).rejects.toThrow(
      /Unknown provider "nope".*azure/,
    );
    await expect(resolveModel('constructor:model', { env: {} })).rejects.toThrow(
      ProviderConfigError,
    );
  });

  it('needs no key for a local Ollama model', async () => {
    const client = await resolveModel('ollama:llama3.1:8b', { env: {} });
    expect(client.id).toBe('ollama:llama3.1:8b');
  });
});

describe('capabilitiesFor', () => {
  it('matches the longest known prefix and falls back to defaults', () => {
    expect(capabilitiesFor('gpt-5-mini-2025-08-07').contextWindow).toBe(400_000);
    expect(capabilitiesFor('GPT-4.1-nano').contextWindow).toBe(1_047_576);
    expect(capabilitiesFor('my-custom-deployment')).toEqual(DEFAULT_CAPABILITIES);
  });
});

describe('provider settings from config', () => {
  async function requestWith(spec: string, options: Parameters<typeof resolveModel>[1]) {
    const { fetch, requests } = capturingFetch();
    const client = await resolveModel(spec, { ...options, fetch });
    const stream = client.stream({ system: '', messages: [] })[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow();
    return requests[0]!;
  }

  it('uses config settings over environment variables, resolving env() when needed', async () => {
    const request = await requestWith('azure:dep', {
      env: {
        MY_KEY: 'from-config',
        AZURE_OPENAI_API_KEY: 'from-env',
        AZURE_OPENAI_ENDPOINT: 'https://env.openai.azure.com',
      },
      providers: { azure: { apiKey: env('MY_KEY'), endpoint: 'https://config.openai.azure.com' } },
    });

    expect(request.url).toMatch(/^https:\/\/config\.openai\.azure\.com\/openai\/v1\/responses/);
    expect(request.headers.get('api-key')).toBe('from-config');
  });

  it('adds an OpenAI-compatible server under its own name', async () => {
    const request = await requestWith('lmstudio:qwen3', {
      env: {},
      providers: {
        lmstudio: {
          type: 'openai-compatible',
          baseURL: 'http://localhost:1234/v1',
          apiKey: 'local',
        },
      },
    });

    expect(request.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer local');
  });

  it('never gives a custom-named provider the built-in environment variables', async () => {
    await expect(
      resolveModel('azure-eu:dep', {
        env: { AZURE_OPENAI_API_KEY: 'key-of-the-other-resource' },
        providers: { 'azure-eu': { type: 'azure', endpoint: 'https://eu.openai.azure.com' } },
      }),
    ).rejects.toThrow(
      'Provider "azure-eu" needs an API key: set providers.azure-eu.apiKey in heaw.config.ts',
    );
  });

  it('names the setting and variable when an env() variable is missing', async () => {
    await expect(
      resolveModel('azure:dep', { env: {}, providers: { azure: { apiKey: env('NOT_SET') } } }),
    ).rejects.toThrow(
      'providers.azure.apiKey in heaw.config.ts reads the environment variable NOT_SET, which is not set.',
    );
  });

  it('requires a base URL for OpenAI-compatible providers and a known type for custom names', async () => {
    await expect(
      resolveModel('local:m', { env: {}, providers: { local: { type: 'openai-compatible' } } }),
    ).rejects.toThrow('Provider "local" needs a base URL');
    await expect(
      resolveModel('mystery:m', { env: {}, providers: { mystery: {} } }),
    ).rejects.toThrow('Unknown provider "mystery"');
  });

  it('applies capability corrections from config', async () => {
    const client = await resolveModel('azure:my-custom-name', {
      env: AZURE_ENV,
      capabilities: { contextWindow: 400_000, reasoning: true },
    });

    expect(client.capabilities).toMatchObject({
      contextWindow: 400_000,
      reasoning: true,
      vision: false,
    });
  });
});
