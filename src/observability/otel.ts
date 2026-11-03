import { randomBytes } from 'node:crypto';
import type { EngineEvent } from '../core/events.js';
import { textOf } from '../core/messages.js';
import { VERSION } from '../version.js';

/** Where and how to send traces (docs/DESIGN.md §4.14). */
export interface TelemetryOptions {
  /**
   * An OTLP/HTTP endpoint: a base URL such as `http://localhost:4318` (spans go to
   * `/v1/traces`), or the full traces URL.
   */
  endpoint: string;
  headers?: Record<string, string>;
  /** Default: `heaw`. */
  serviceName?: string;
  /** Also record prompts, answers and tool arguments and results. Default: off. */
  captureContent?: boolean;
  /** Applied to every recorded text, e.g. to remove secrets. */
  redact?: (text: string) => string;
  fetch?: typeof globalThis.fetch;
}

type AttributeValue = string | number | boolean;

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  start: number;
  end?: number;
  attributes: Record<string, AttributeValue>;
  events: Array<{ name: string; time: number; attributes: Record<string, AttributeValue> }>;
  status?: { code: 2; message: string };
}

const SPAN_KIND = { internal: 1, client: 3 } as const;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BATCH = 200;

/** OpenTelemetry provider names for heaw's providers (GenAI semantic conventions). */
const PROVIDER_NAMES: Record<string, string> = {
  azure: 'azure.ai.openai',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gcp.gemini',
};

/**
 * Turns the engine's event stream into OpenTelemetry spans following the GenAI semantic
 * conventions, and sends them over OTLP/HTTP (JSON), which Jaeger, Langfuse, Phoenix and
 * collectors accept. A run is an `invoke_agent` span; each model call a `chat <model>` span and
 * each tool call an `execute_tool <name>` span inside it; a sub-agent's run sits under the
 * `delegate` call that started it.
 */
export class OtelTracer {
  readonly #options: TelemetryOptions;
  readonly #url: string;
  readonly #redact: (text: string) => string;
  /** The open run span of each agent. */
  readonly #runs = new Map<string, SpanRecord>();
  /** The open model call span of each agent. */
  readonly #calls = new Map<string, SpanRecord>();
  /** Open tool spans by agent and call id. */
  readonly #tools = new Map<string, SpanRecord>();
  /** Open delegate spans waiting for the sub-agent they start. */
  readonly #delegates: SpanRecord[] = [];
  /** Where each sub-agent's run goes, by its agent id. */
  readonly #subagentParents = new Map<string, SpanRecord>();
  #queue: SpanRecord[] = [];
  #sending: Promise<void> = Promise.resolve();
  readonly #timer: NodeJS.Timeout;
  /** The last failed export, to tell the user once. */
  lastError: string | undefined;

  constructor(options: TelemetryOptions) {
    this.#options = options;
    this.#url = /\/v1\/traces\/?$/.test(options.endpoint)
      ? options.endpoint
      : `${options.endpoint.replace(/\/+$/, '')}/v1/traces`;
    this.#redact = options.redact ?? ((text) => text);
    this.#timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.#timer.unref();
  }

  /** Feeds one engine event. */
  record(event: EngineEvent): void {
    const agent = event.agentId;
    switch (event.type) {
      case 'run.start': {
        const parent = this.#subagentParents.get(agent);
        const span = this.#open(
          `invoke_agent ${agent}`,
          event.timestamp,
          parent,
          SPAN_KIND.internal,
          {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': agent,
            'gen_ai.conversation.id': event.sessionId,
            'session.id': event.sessionId,
            ...(event.intent && { 'heaw.intent': event.intent }),
          },
        );
        if (this.#options.captureContent) span.attributes['heaw.input'] = this.#text(event.input);
        this.#runs.set(agent, span);
        break;
      }
      case 'turn.start': {
        const run = this.#runs.get(agent);
        if (!run) break;
        this.#calls.set(
          agent,
          this.#open('chat', event.timestamp, run, SPAN_KIND.client, {
            'gen_ai.operation.name': 'chat',
            'heaw.turn': event.turn,
          }),
        );
        break;
      }
      case 'message.complete': {
        const call = this.#calls.get(agent);
        if (call && this.#options.captureContent) {
          call.attributes['gen_ai.output.messages'] = this.#text(
            JSON.stringify([
              { role: 'assistant', parts: [{ type: 'text', content: textOf(event.message) }] },
            ]),
          );
        }
        break;
      }
      case 'usage': {
        const call = this.#calls.get(agent);
        const span =
          call ??
          this.#open('chat', event.timestamp, this.#runs.get(agent), SPAN_KIND.client, {
            'gen_ai.operation.name': 'chat',
          });
        Object.assign(span.attributes, modelAttributes(event.model), {
          'gen_ai.usage.input_tokens': event.usage.inputTokens,
          'gen_ai.usage.output_tokens': event.usage.outputTokens,
          'heaw.usage.cache_read_tokens': event.usage.cacheReadTokens,
          'heaw.usage.reasoning_tokens': event.usage.reasoningTokens,
          ...(event.costUsd !== undefined && { 'heaw.cost_usd': usd(event.costUsd) }),
        });
        if (event.model) span.name = `chat ${modelName(event.model)}`;
        this.#close(span, event.timestamp);
        this.#calls.delete(agent);
        break;
      }
      case 'tool.start': {
        const span = this.#open(
          `execute_tool ${event.tool}`,
          event.timestamp,
          this.#runs.get(agent),
          SPAN_KIND.internal,
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.tool,
            'gen_ai.tool.call.id': event.callId,
          },
        );
        if (this.#options.captureContent) {
          span.attributes['gen_ai.tool.call.arguments'] = this.#text(JSON.stringify(event.args));
        }
        this.#tools.set(`${agent}:${event.callId}`, span);
        if (event.tool === 'delegate') this.#delegates.push(span);
        break;
      }
      case 'approval.request':
      case 'approval.response': {
        const span =
          event.type === 'approval.request'
            ? this.#tools.get(`${agent}:${event.callId}`)
            : this.#runs.get(agent);
        span?.events.push({
          name: event.type,
          time: event.timestamp,
          attributes:
            event.type === 'approval.request'
              ? { reason: event.reason }
              : { allowed: event.decision.allow },
        });
        break;
      }
      case 'tool.end': {
        const key = `${agent}:${event.callId}`;
        const span = this.#tools.get(key);
        if (!span) break;
        span.attributes['heaw.tool.status'] = event.status;
        if (this.#options.captureContent)
          span.attributes['gen_ai.tool.call.result'] = this.#text(event.output);
        if (event.status === 'error')
          span.status = { code: 2, message: this.#text(event.output.slice(0, 500)) };
        this.#close(span, event.timestamp);
        this.#tools.delete(key);
        const waiting = this.#delegates.indexOf(span);
        if (waiting !== -1) this.#delegates.splice(waiting, 1);
        break;
      }
      case 'subagent.start': {
        // Parallel delegate calls cannot be told apart; the oldest open one is close enough.
        const parent = this.#delegates.shift() ?? this.#runs.get(agent);
        if (parent) this.#subagentParents.set(event.childAgentId, parent);
        break;
      }
      case 'compaction':
      case 'hook':
      case 'error': {
        this.#runs.get(agent)?.events.push({
          name: event.type === 'error' ? 'exception' : event.type,
          time: event.timestamp,
          attributes: eventAttributes(event, (text) => this.#text(text)),
        });
        break;
      }
      case 'link': {
        // Joins traces to the pull requests and commits they produced.
        this.#runs.get(agent)?.events.push({
          name: 'heaw.link',
          time: event.timestamp,
          attributes: {
            'heaw.link.kind': event.kind,
            'heaw.link.ref': event.ref,
            ...(event.title !== undefined && { 'heaw.link.title': this.#text(event.title) }),
          },
        });
        break;
      }
      case 'run.end': {
        const run = this.#runs.get(agent);
        if (!run) break;
        Object.assign(run.attributes, {
          'gen_ai.usage.input_tokens': event.usage.inputTokens,
          'gen_ai.usage.output_tokens': event.usage.outputTokens,
          'heaw.stop_reason': event.stopReason,
          'heaw.turns': event.turns,
          ...(event.costUsd !== undefined && { 'heaw.cost_usd': usd(event.costUsd) }),
        });
        if (event.stopReason === 'error') run.status = { code: 2, message: 'the run failed' };
        // Anything still open ends with the run (e.g. an aborted model call).
        const open = this.#calls.get(agent);
        if (open) this.#close(open, event.timestamp);
        this.#calls.delete(agent);
        this.#close(run, event.timestamp);
        this.#runs.delete(agent);
        this.#subagentParents.delete(agent);
        break;
      }
      default:
        break;
    }
  }

  /** Sends the finished spans now. */
  flush(): Promise<void> {
    if (!this.#queue.length) return this.#sending;
    const batch = this.#queue;
    this.#queue = [];
    this.#sending = this.#sending.then(() => this.#send(batch));
    return this.#sending;
  }

  /** Sends what is left and stops the timer. */
  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
  }

  #open(
    name: string,
    time: number,
    parent: SpanRecord | undefined,
    kind: number,
    attributes: Record<string, AttributeValue>,
  ): SpanRecord {
    return {
      traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      ...(parent && { parentSpanId: parent.spanId }),
      name,
      kind,
      start: time,
      attributes,
      events: [],
    };
  }

  #close(span: SpanRecord, time: number): void {
    span.end = Math.max(time, span.start);
    this.#queue.push(span);
    if (this.#queue.length >= MAX_BATCH) void this.flush();
  }

  #text(text: string): string {
    return this.#redact(text);
  }

  async #send(spans: SpanRecord[]): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({
              'service.name': this.#options.serviceName ?? 'heaw',
              'service.version': VERSION,
              'telemetry.sdk.name': 'heaw',
            }),
          },
          scopeSpans: [{ scope: { name: 'heaw', version: VERSION }, spans: spans.map(toOtlp) }],
        },
      ],
    };
    try {
      const response = await (this.#options.fetch ?? globalThis.fetch)(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) this.lastError = `${this.#url} answered HTTP ${response.status}`;
    } catch (error) {
      this.lastError = `${this.#url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * Telemetry settings from the standard OpenTelemetry variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, …), or undefined when no endpoint is set.
 */
export function telemetryFromEnv(
  env: Record<string, string | undefined>,
): Omit<TelemetryOptions, 'redact' | 'fetch'> | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  const headers = parseHeaders(
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  return {
    endpoint,
    ...(Object.keys(headers).length && { headers }),
    ...(env.OTEL_SERVICE_NAME && { serviceName: env.OTEL_SERVICE_NAME }),
    ...(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true' && {
      captureContent: true,
    }),
  };
}

/** `key1=value1,key2=value2`, values URL-encoded, as OTEL_EXPORTER_OTLP_HEADERS has them. */
function parseHeaders(text: string | undefined): Record<string, string> {
  if (!text) return {};
  return Object.fromEntries(
    text
      .split(',')
      .map((pair) => pair.split('='))
      .filter((parts) => parts.length >= 2 && parts[0]!.trim())
      .map(([key, ...rest]) => [key!.trim(), decodeURIComponent(rest.join('=').trim())]),
  );
}

function modelAttributes(model: string | undefined): Record<string, AttributeValue> {
  if (!model) return {};
  const provider = model.slice(0, model.indexOf(':'));
  return {
    'gen_ai.provider.name': PROVIDER_NAMES[provider] ?? provider,
    'gen_ai.request.model': modelName(model),
  };
}

function modelName(model: string): string {
  return model.slice(model.indexOf(':') + 1);
}

function eventAttributes(
  event: Extract<EngineEvent, { type: 'compaction' | 'hook' | 'error' }>,
  text: (value: string) => string,
): Record<string, AttributeValue> {
  if (event.type === 'compaction') {
    return {
      method: event.method,
      before_tokens: event.beforeTokens,
      after_tokens: event.afterTokens,
    };
  }
  if (event.type === 'hook') return { hook: event.hook, message: text(event.message) };
  return {
    'exception.type': event.error.name,
    'exception.message': text(event.error.message),
    recoverable: event.recoverable,
  };
}

function toOtlp(span: SpanRecord) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId && { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: nanos(span.start),
    endTimeUnixNano: nanos(span.end ?? span.start),
    attributes: toAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: nanos(event.time),
      attributes: toAttributes(event.attributes),
    })),
    status: span.status ?? { code: 0 },
  };
}

function toAttributes(attributes: Record<string, AttributeValue>) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));
}

function nanos(ms: number): string {
  return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

/** Dollars without float noise (0.0223915, not 0.022391499999999998). */
function usd(amount: number): number {
  return Math.round(amount * 1e7) / 1e7;
}
