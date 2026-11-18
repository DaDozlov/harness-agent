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

/** GPT-5.5 and later: 1,050,000 tokens of context (at most 922,000 of them input). */
const LONG_GPT: Partial<ModelCapabilities> = {
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  vision: true,
  reasoning: true,
  promptCaching: true,
};

/** Claude 4.6 and later (Haiku 4.5 excepted): 1M tokens of context. */
const LONG_CLAUDE: Partial<ModelCapabilities> = {
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  vision: true,
  reasoning: true,
  promptCaching: true,
};

/** Gemini 2.5 and later; Gemini 4 writes up to 1M tokens only with "long decode". */
const GEMINI: Partial<ModelCapabilities> = {
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  vision: true,
  reasoning: true,
  promptCaching: true,
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
  'gpt-5.5': LONG_GPT,
  'gpt-5.6': LONG_GPT,
  'gpt-6': LONG_GPT,
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    reasoning: true,
    promptCaching: true,
  },
  'claude-sonnet-4-6': LONG_CLAUDE,
  'claude-opus-4-6': LONG_CLAUDE,
  'claude-opus-4-7': LONG_CLAUDE,
  'claude-opus-4-8': LONG_CLAUDE,
  'claude-opus-5': LONG_CLAUDE,
  'claude-sonnet-5': LONG_CLAUDE,
  'claude-haiku-5': LONG_CLAUDE,
  'claude-fable-5': LONG_CLAUDE,
  'gemini-2.5': GEMINI,
  'gemini-3': GEMINI,
  'gemini-4': GEMINI,
};

/**
 * List prices in USD per million tokens (standard tier), from the providers' price pages on
 * 18 November 2026. Unlike capabilities, a price applies only to that exact model or a dated
 * version of it (`gpt-5-2025-08-07`), never to a family: `gpt-5.4` costs more than `gpt-5`.
 * Long-context surcharges are not modelled (Claude Haiku 5.5 costs more above 100K tokens,
 * GPT-5.5 and later above 272K, Gemini Pro above 200K). Where a price list announced a
 * higher price within weeks (Gemini 4 Carbon and Argon on 1 December, Gemini 3.8 Flash on
 * 1 January), it is the one here: a cost limit that stops early beats one that stops late.
 * Azure deployments and negotiated prices can differ; set prices in heaw.config.ts
 * (`models: { 'azure:x': { pricing: { … } } }`).
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
  'gpt-5.1': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5.2': { input: 1.75, cacheRead: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-6-astra': { input: 10, cacheRead: 1, output: 50 },
  'gpt-6-sol': { input: 2, cacheRead: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cacheRead: 0.01, output: 0.5 },
  'gpt-6.1-sol': { input: 2, cacheRead: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cacheRead: 0.05, output: 5 },
  'gpt-6.2-sol': { input: 2, cacheRead: 0.1, output: 10 },
  'gpt-6.2-astra': { input: 8, cacheRead: 0.4, output: 40 },
  o3: { input: 2, cacheRead: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cacheRead: 0.275, output: 4.4 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-fable-5-2': { input: 8, cacheRead: 0.2, cacheWrite: 10, output: 40 },
  'gemini-2.5-pro': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gemini-3.1-pro-preview': { input: 2, cacheRead: 0.2, output: 12 },
  'gemini-3.5-flash-lite': { input: 0.3, cacheRead: 0.03, output: 2.5 },
  'gemini-3.8-flash': { input: 1.5, cacheRead: 0.15, output: 7.5 },
  'gemini-4-hydrogen': { input: 1.5, cacheRead: 0.075, output: 7.5 },
  'gemini-4-argon': { input: 4, cacheRead: 0.2, output: 20 },
  'gemini-4-carbon': { input: 4, cacheRead: 0.2, output: 20 },
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
