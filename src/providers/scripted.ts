import { setTimeout as sleep } from 'node:timers/promises';
import { ModelError } from '../core/errors.js';
import type { AssistantMessage } from '../core/messages.js';
import type {
  FinishReason,
  ModelCapabilities,
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
} from '../core/model.js';
import { emptyUsage, type Usage } from '../core/usage.js';
import { DEFAULT_CAPABILITIES } from './catalog.js';

export interface ScriptedResponse {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args?: unknown; id?: string }>;
  finishReason?: FinishReason;
  usage?: Partial<Usage>;
  /** Thrown before any output, like a failed request. */
  error?: Error;
  /** Thrown after `text` has streamed, like a connection that drops mid-answer. */
  errorAfterText?: Error;
  /** `text` streams in chunks of this many characters. Default: 8. */
  chunkSize?: number;
  /** Wait before each chunk, e.g. to abort mid-stream in tests. */
  chunkDelayMs?: number;
}

/**
 * A fake model that replays scripted responses, one per call. Used to test the engine, and
 * agents built on it, deterministically and without API calls.
 */
export class ScriptedModelClient implements ModelClient {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  /** A snapshot of every request received, for assertions. */
  readonly requests: ModelRequest[] = [];
  readonly #responses: ScriptedResponse[];
  #calls = 0;

  constructor(
    responses: ScriptedResponse[],
    options: { id?: string; capabilities?: Partial<ModelCapabilities> } = {},
  ) {
    this.#responses = responses;
    this.id = options.id ?? 'scripted:test';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const response = this.#responses[this.#calls++];
    if (!response) {
      throw new ModelError(`No scripted response left for call ${this.#calls}.`, {
        retryable: false,
      });
    }
    signal?.throwIfAborted();
    if (response.error) throw response.error;

    const message: AssistantMessage = { role: 'assistant', content: [] };
    if (response.reasoning) {
      yield { type: 'reasoning-delta', text: response.reasoning };
      message.content.push({ type: 'reasoning', text: response.reasoning });
    }
    if (response.text) {
      const size = response.chunkSize ?? 8;
      for (let i = 0; i < response.text.length; i += size) {
        if (response.chunkDelayMs) await sleep(response.chunkDelayMs, undefined, { signal });
        signal?.throwIfAborted();
        yield { type: 'text-delta', text: response.text.slice(i, i + size) };
      }
      message.content.push({ type: 'text', text: response.text });
    }
    if (response.errorAfterText) throw response.errorAfterText;

    for (const [index, call] of (response.toolCalls ?? []).entries()) {
      message.content.push({
        type: 'tool-call',
        id: call.id ?? `call_${this.#calls}_${index}`,
        name: call.name,
        args: call.args ?? {},
      });
    }

    yield {
      type: 'finish',
      message,
      finishReason: response.finishReason ?? (response.toolCalls?.length ? 'tool-calls' : 'stop'),
      usage: { ...emptyUsage(), ...response.usage },
    };
  }
}
