import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FinishReason,
  type LanguageModelV4Prompt,
  type LanguageModelV4ToolCall,
  type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { isAbortError, ModelError } from '../core/errors.js';
import type {
  AssistantMessage,
  ProviderMetadata,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from '../core/messages.js';
import type {
  FinishReason,
  ModelCapabilities,
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
} from '../core/model.js';
import type { Usage } from '../core/usage.js';

type ProviderOptions = NonNullable<LanguageModelV4CallOptions['providerOptions']>;

/**
 * Adapts any AI SDK provider model (OpenAI, Azure, Anthropic, Google, …) to `ModelClient`.
 * Uses only the provider's `doStream`: one call, no tool execution, no retries. The engine
 * owns all of that.
 */
export class AiSdkModelClient implements ModelClient {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  readonly #model: LanguageModelV4;
  /** The provider lost an item the history referred to: from then on, it goes inline. */
  #inline = false;
  /** The model refused a reasoning effort (it does not reason): from then on, none is sent. */
  #noReasoning = false;
  /** Whether tool results can carry images to this API; otherwise only their descriptions go. */
  readonly #images: boolean;

  constructor(id: string, model: LanguageModelV4, capabilities: ModelCapabilities) {
    this.id = id;
    this.#model = model;
    this.capabilities = capabilities;
    this.#images = capabilities.vision && takesImagesInToolResults(model.provider);
  }

  /**
   * OpenAI and Azure keep the items of a conversation (reasoning, tool calls, answers), and the
   * history refers to them by id. A stored item can expire or go missing ("Item with id 'rs_…'
   * not found"), which fails every later request; the call is then made again, and all later
   * ones, with the history sent inline: earlier reasoning is left out, the rest is kept.
   */
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    let started = false;
    try {
      for await (const event of this.#streamOnce(this.#withoutRefused(request), signal)) {
        started = true;
        yield event;
      }
    } catch (error) {
      if (started) throw error;
      if (!this.#inline && isMissingItem(error)) {
        this.#inline = true;
      } else if (!this.#noReasoning && request.reasoningEffort && refusesReasoning(error)) {
        // A reasoning effort set for the whole project reaches models that cannot reason, and
        // some providers reject it ("does not support thinking", Ollama); others ignore it.
        this.#noReasoning = true;
      } else {
        throw error;
      }
      yield* this.stream(request, signal);
    }
  }

  #withoutRefused(request: ModelRequest): ModelRequest {
    if (!this.#noReasoning || !request.reasoningEffort) return request;
    const copy = { ...request };
    delete copy.reasoningEffort;
    return copy;
  }

  async *#streamOnce(
    request: ModelRequest,
    signal: AbortSignal | undefined,
  ): AsyncIterable<ModelStreamEvent> {
    const builder = new MessageBuilder();
    const repeats = new RepeatFilter();
    let finish:
      { finishReason: LanguageModelV4FinishReason; usage: LanguageModelV4Usage } | undefined;

    try {
      const { stream } = await this.#model.doStream(
        toCallOptions(request, signal, { inline: this.#inline, images: this.#images }),
      );
      for await (const part of stream) {
        switch (part.type) {
          case 'text-start':
          case 'reasoning-start':
            builder.open(kindOf(part.type), part.id, part.providerMetadata);
            break;
          case 'text-delta': {
            builder.append('text', part.id, part.delta, part.providerMetadata);
            const shown = repeats.delta(part.id, part.delta);
            if (shown) yield { type: 'text-delta', text: shown };
            break;
          }
          case 'reasoning-delta':
            builder.append('reasoning', part.id, part.delta, part.providerMetadata);
            yield { type: 'reasoning-delta', text: part.delta };
            break;
          case 'text-end':
          case 'reasoning-end':
            builder.close(kindOf(part.type), part.id, part.providerMetadata);
            if (part.type === 'text-end') repeats.end(part.id);
            break;
          case 'tool-call':
            // Provider-executed tools (e.g. built-in web search) are not used yet.
            if (!part.providerExecuted) builder.toolCall(part);
            break;
          case 'finish':
            finish = part;
            break;
          case 'error':
            throw toModelError(part.error);
          default:
            // Tool input deltas, sources, files, metadata and raw chunks are not needed yet.
            break;
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      throw toModelError(error);
    }

    if (!finish) {
      throw new ModelError('The model stream ended without a finish event.', { retryable: true });
    }
    yield {
      type: 'finish',
      message: builder.message(),
      finishReason: mapFinishReason(finish.finishReason),
      usage: mapUsage(finish.usage),
    };
  }
}

/**
 * The OpenAI Responses API (also Azure's) and Anthropic take images in tool results. Chat
 * Completions APIs (OpenAI-compatible servers such as Ollama) would get them as JSON text:
 * megabytes of base64 in place of a picture.
 */
export function takesImagesInToolResults(provider: string): boolean {
  return provider.endsWith('.responses') || provider.startsWith('anthropic');
}

interface PromptOptions {
  /** Send the history inline instead of referring to stored items. */
  inline?: boolean;
  /** Send the images of tool results as images. */
  images?: boolean;
}

export function toCallOptions(
  request: ModelRequest,
  signal?: AbortSignal,
  options: PromptOptions = {},
): LanguageModelV4CallOptions {
  const tools = request.tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return {
    prompt: toPrompt(request, options),
    ...(tools?.length && { tools, toolChoice: { type: request.toolChoice ?? 'auto' } }),
    ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.reasoningEffort && { reasoning: request.reasoningEffort }),
    ...providerOptionsOf(request),
    ...(signal && { abortSignal: signal }),
  };
}

/**
 * The request's provider options, with its cache key as OpenAI's `promptCacheKey` (Azure reads
 * it under its own name). Other providers ignore options that are not theirs.
 */
function providerOptionsOf(request: ModelRequest): { providerOptions?: ProviderOptions } {
  const given = request.providerOptions ?? {};
  if (!request.cacheKey) {
    return request.providerOptions ? { providerOptions: given as ProviderOptions } : {};
  }
  const keyed = (name: string) => ({ promptCacheKey: request.cacheKey, ...given[name] });
  return {
    providerOptions: {
      ...given,
      openai: keyed('openai'),
      azure: keyed('azure'),
    },
  };
}

/** `inline`: without the ids of stored items, so nothing refers to items the provider keeps. */
export function toPrompt(
  request: ModelRequest,
  options: PromptOptions = {},
): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (request.system) prompt.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        prompt.push({
          role: 'user',
          content: message.content.map((part) => ({ type: 'text', text: part.text })),
        });
        break;
      case 'assistant':
        prompt.push({
          role: 'assistant',
          content: message.content.map((part) => {
            const providerOptions = optionsFrom(part.providerMetadata, options.inline);
            return part.type === 'tool-call'
              ? {
                  type: 'tool-call',
                  toolCallId: part.id,
                  toolName: part.name,
                  input: part.args,
                  ...providerOptions,
                }
              : { type: part.type, text: part.text, ...providerOptions };
          }),
        });
        break;
      case 'tool':
        prompt.push({
          role: 'tool',
          content: message.content.map((part) => ({
            type: 'tool-result',
            toolCallId: part.callId,
            toolName: part.name,
            output: toolOutput(part, options.images === true),
          })),
        });
        break;
    }
  }
  return prompt;
}

function toolOutput(part: ToolResultPart, images: boolean): LanguageModelV4ToolResultOutput {
  if (part.isError) return { type: 'error-text', value: part.output };
  if (!images || !part.images?.length) return { type: 'text', value: part.output };
  return {
    type: 'content',
    value: [
      { type: 'text', text: part.output },
      ...part.images.map((image) => ({
        type: 'file' as const,
        mediaType: image.mediaType,
        data: { type: 'data' as const, data: image.data },
      })),
    ],
  };
}

/** Provider metadata from a response goes back to the same provider as provider options. */
function optionsFrom(
  metadata: ProviderMetadata | undefined,
  inline = false,
): { providerOptions?: ProviderOptions } {
  if (!metadata) return {};
  if (!inline) return { providerOptions: metadata as ProviderOptions };
  const withoutIds = Object.fromEntries(
    Object.entries(metadata).map(([provider, values]) => [
      provider,
      Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'itemId')),
    ]),
  );
  return { providerOptions: withoutIds as ProviderOptions };
}

/** The provider no longer has an item the request refers to. */
function isMissingItem(error: unknown): boolean {
  return (
    error instanceof ModelError &&
    error.status === 400 &&
    /item with id '[^']*' not found/i.test(error.message)
  );
}

/** The model rejected the reasoning effort because it does not reason. */
function refusesReasoning(error: unknown): boolean {
  return (
    error instanceof ModelError &&
    error.status === 400 &&
    /does not support (thinking|reasoning)|reasoning(_effort|\.effort)?\b[^.]*\b(not supported|unsupported)|unsupported (parameter|value)[^.]*reasoning/i.test(
      error.message,
    )
  );
}

function kindOf(type: `${'text' | 'reasoning'}-${string}`): 'text' | 'reasoning' {
  return type.startsWith('text') ? 'text' : 'reasoning';
}

/** Assembles the streamed parts into one assistant message, in the order they started. */
class MessageBuilder {
  readonly #parts: Array<TextPart | ReasoningPart | ToolCallPart> = [];
  readonly #open = new Map<string, TextPart | ReasoningPart>();

  open(kind: 'text' | 'reasoning', id: string, metadata: ProviderMetadata | undefined): void {
    const part: TextPart | ReasoningPart = { type: kind, text: '' };
    this.#parts.push(part);
    this.#open.set(`${kind}:${id}`, part);
    mergeMetadata(part, metadata);
  }

  append(
    kind: 'text' | 'reasoning',
    id: string,
    text: string,
    metadata: ProviderMetadata | undefined,
  ): void {
    if (!this.#open.has(`${kind}:${id}`)) this.open(kind, id, undefined);
    const part = this.#open.get(`${kind}:${id}`)!;
    part.text += text;
    mergeMetadata(part, metadata);
  }

  close(kind: 'text' | 'reasoning', id: string, metadata: ProviderMetadata | undefined): void {
    const part = this.#open.get(`${kind}:${id}`);
    if (part) mergeMetadata(part, metadata);
    this.#open.delete(`${kind}:${id}`);
  }

  toolCall(call: LanguageModelV4ToolCall): void {
    this.#parts.push({
      type: 'tool-call',
      id: call.toolCallId,
      name: call.toolName,
      args: parseArgs(call.input),
      ...(call.providerMetadata && { providerMetadata: call.providerMetadata }),
    });
  }

  message(): AssistantMessage {
    // Empty reasoning parts are kept when they carry metadata: providers such as OpenAI need
    // the reasoning item ids back on the next call even when no reasoning text was shown.
    const content = this.#parts.filter(
      (part) => part.type === 'tool-call' || part.text !== '' || part.providerMetadata,
    );
    return { role: 'assistant', content };
  }
}

/**
 * Some models (GPT-5 with message phases) repeat a progress message word for word as the final
 * answer of the same response. The history keeps both, as the provider needs them; the user is
 * shown the text once. A later text part is held back while it only repeats an earlier one.
 */
export class RepeatFilter {
  readonly #ended: string[] = [];
  readonly #open = new Map<string, { text: string; shown: boolean }>();

  /** What to show of a text delta: nothing, the delta, or the held-back text plus the delta. */
  delta(id: string, text: string): string {
    let part = this.#open.get(id);
    if (!part) this.#open.set(id, (part = { text: '', shown: !this.#ended.length }));
    part.text += text;
    if (part.shown) return text;
    const current = part.text;
    if (this.#ended.some((earlier) => earlier.startsWith(current))) return '';
    part.shown = true;
    return current;
  }

  end(id: string): void {
    const part = this.#open.get(id);
    if (!part) return;
    this.#ended.push(part.text);
    this.#open.delete(id);
  }
}

function mergeMetadata(
  part: TextPart | ReasoningPart,
  metadata: ProviderMetadata | undefined,
): void {
  if (!metadata) return;
  const merged: ProviderMetadata = { ...part.providerMetadata };
  for (const [provider, values] of Object.entries(metadata)) {
    merged[provider] = { ...merged[provider], ...values };
  }
  part.providerMetadata = merged;
}

/** Tool arguments arrive as JSON text. Invalid JSON is kept as a string for validation to reject. */
function parseArgs(input: string): unknown {
  if (input.trim() === '') return {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function mapFinishReason(reason: LanguageModelV4FinishReason): FinishReason {
  switch (reason.unified) {
    case 'stop':
    case 'length':
    case 'tool-calls':
    case 'content-filter':
    case 'interrupted':
      return reason.unified;
    default:
      return 'other';
  }
}

function mapUsage(usage: LanguageModelV4Usage): Usage {
  return {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    reasoningTokens: usage.outputTokens.reasoning ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
  };
}

export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (APICallError.isInstance(error)) {
    const retryAfterMs = retryAfter(error.responseHeaders);
    return new ModelError(error.message, {
      retryable: error.isRetryable,
      ...(error.statusCode !== undefined && { status: error.statusCode }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      cause: error,
    });
  }
  return new ModelError(describe(error), { retryable: cutOff(error), cause: error });
}

/**
 * The response stopped half way: the server or the connection dropped it (a local model server
 * that ran out of memory, a proxy that timed out). Asking again usually works.
 */
function cutOff(error: unknown): boolean {
  if (InvalidResponseDataError.isInstance(error)) return /stream ended/i.test(error.message);
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError' && error.message === 'terminated') return true;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && DROPPED_CONNECTION.has(code);
}

const DROPPED_CONNECTION = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

function retryAfter(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers['retry-after'];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
