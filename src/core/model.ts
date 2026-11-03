import type { AssistantMessage, Message } from './messages.js';
import type { ModelPricing, Usage } from './usage.js';

/**
 * The engine's only view of a language model. Provider adapters implement it; the core never
 * imports a provider SDK.
 */
export interface ModelClient {
  /** `provider:model`, e.g. `azure:my-gpt5-deployment`. */
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  /**
   * One model call. Yields deltas while streaming and ends with exactly one `finish` event.
   * Failures are thrown as `ModelError`; an aborted signal throws an `AbortError`.
   */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  /** List prices, when known; costs and cost limits need them. */
  pricing?: ModelPricing;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Passed through to the provider untouched, e.g. cache hints. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export type FinishReason =
  'stop' | 'length' | 'tool-calls' | 'content-filter' | 'interrupted' | 'other';

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  /** The complete assistant message, assembled by the adapter, including provider metadata. */
  | { type: 'finish'; message: AssistantMessage; finishReason: FinishReason; usage: Usage };
