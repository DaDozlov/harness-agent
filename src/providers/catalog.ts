import type { ModelCapabilities } from '../core/model.js';
import type { ModelPricing } from '../core/usage.js';

/** Used for models the catalog doesn't know, e.g. Azure deployments with custom names. */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  parallelToolCalls: true,
  vision: false,
  reasoning: false,
  promptCaching: false,
};

/**
 * Known model families, matched by the longest prefix of the model id, so dated or sized
 * variants (`gpt-5-2025-08-07`, `gpt-5-mini`) resolve to their family. Projects correct them
 * with `models` in heaw.config.ts.
 */
const KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384, vision: true, promptCaching: true },
  'gpt-4.1': {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    vision: true,
    promptCaching: true,
  },
  'gpt-5': {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  o3: {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  'o4-mini': {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  'gemini-2.5': {
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
};

/**
 * List prices in USD per million tokens, from public price lists in November 2026. Unlike
 * capabilities, a price applies only to that exact model or a dated version of it
 * (`gpt-5-2025-08-07`), never to a family: `gpt-5.4` costs more than `gpt-5`. Long-context
 * surcharges are not modelled. Azure deployments and negotiated prices can differ; set prices
 * in heaw.config.ts (`models: { 'azure:x': { pricing: { … } } }`).
 */
const KNOWN_PRICES: Record<string, ModelPricing> = {
  'gpt-4o': { input: 2.5, cacheRead: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, output: 0.6 },
  'gpt-4.1': { input: 2, cacheRead: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cacheRead: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cacheRead: 0.025, output: 0.4 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cacheRead: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cacheRead: 0.005, output: 0.4 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15 },
  o3: { input: 2, cacheRead: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cacheRead: 0.275, output: 4.4 },
  'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};

export function capabilitiesFor(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase();
  const family = Object.keys(KNOWN_MODELS)
    .filter((prefix) => id.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  const pricing = pricingFor(id);
  return {
    ...DEFAULT_CAPABILITIES,
    ...(family && KNOWN_MODELS[family]),
    ...(pricing && { pricing }),
  };
}

/** Models with a built-in price. */
export function pricedModels(): string[] {
  return Object.keys(KNOWN_PRICES);
}

/** The price of exactly this model, allowing a date suffix such as `-2025-08-07`. */
export function pricingFor(modelId: string): ModelPricing | undefined {
  const id = modelId.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.hasOwn(KNOWN_PRICES, id) ? KNOWN_PRICES[id] : undefined;
}
