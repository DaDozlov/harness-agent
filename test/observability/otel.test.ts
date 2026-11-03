import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Redactor, referencedVariables, secretsFromEnv } from '../../src/core/redact.js';
import { createEngine } from '../../src/engine.js';
import { OtelTracer, telemetryFromEnv } from '../../src/observability/otel.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { env } from '../../src/providers/settings.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { defineTool } from '../../src/tools/define.js';
import { collect, tempDirFactory, tempWorkspaceFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const tempWorkspace = tempWorkspaceFactory();

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  events: Array<{ name: string }>;
  status: { code: number };
}

/** Captures what the tracer sends. */
function collector() {
  const requests: Array<{ url: string; headers: Record<string, string>; spans: OtlpSpan[] }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    // The tracer sends a JSON string to a URL string.
    const body = JSON.parse(init?.body as string) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
    };
    requests.push({
      url: input as string,
      headers: init?.headers as Record<string, string>,
      spans: body.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    });
    return Promise.resolve(new Response('{}'));
  };
  return { requests, fetch, spans: () => requests.flatMap((request) => request.spans) };
}

const attribute = (span: OtlpSpan | undefined, key: string) => {
  const value = span?.attributes.find((item) => item.key === key)?.value;
  return value && Object.values(value)[0];
};

const echo = defineTool({
  name: 'echo',
  description: 'Echo',
  kind: 'read',
  parameters: z.object({ text: z.string() }),
  run: ({ text }) => `echo: ${text}`,
});

describe('OpenTelemetry traces', () => {
  it('sends a run with its model calls, tool calls and sub-agents as GenAI spans', async () => {
    const { requests, fetch, spans } = collector();
    const engine = await createEngine({
      model: new ScriptedModelClient(
        [
          {
            toolCalls: [{ name: 'echo', args: { text: 'secret-value-123' } }],
            usage: { inputTokens: 100, outputTokens: 10 },
          },
          {
            toolCalls: [{ name: 'delegate', args: { task: 'Look around' } }],
            usage: { inputTokens: 120, outputTokens: 12 },
          },
          { text: 'Nothing here.', usage: { inputTokens: 30, outputTokens: 3 } },
          { text: 'Done.', usage: { inputTokens: 150, outputTokens: 5 } },
        ],
        { id: 'azure:gpt-5.4' },
      ),
      workspace: await tempWorkspace(),
      toolsets: ['agents'],
      tools: [echo],
      git: false,
      telemetry: {
        endpoint: 'http://collector:4318/',
        headers: { authorization: 'Bearer abc' },
        captureContent: true,
        redact: (text) => new Redactor(['secret-value-123']).redact(text),
        fetch,
      },
    });

    await collect(engine.session().send('Do it'));
    await engine.dispose();

    expect(requests[0]?.url).toBe('http://collector:4318/v1/traces');
    expect(requests[0]?.headers).toMatchObject({ authorization: 'Bearer abc' });
    const all = spans();
    const byName = (name: string) => all.filter((span) => span.name === name);
    const [run] = byName('invoke_agent main');
    const chats = byName('chat gpt-5.4');
    const [tool] = byName('execute_tool echo');
    const [delegate] = byName('execute_tool delegate');
    const [child] = byName('invoke_agent agent-1');

    expect(run?.parentSpanId).toBeUndefined();
    expect(attribute(run, 'gen_ai.operation.name')).toBe('invoke_agent');
    expect(attribute(run, 'heaw.stop_reason')).toBe('end_turn');
    expect(attribute(run, 'gen_ai.usage.input_tokens')).toBe('400');
    expect(chats).toHaveLength(4);
    expect(chats.map((span) => attribute(span, 'gen_ai.usage.input_tokens'))).toEqual([
      '100',
      '120',
      '30',
      '150',
    ]);
    expect(attribute(chats[0], 'gen_ai.provider.name')).toBe('azure.ai.openai');
    expect(attribute(chats[0], 'gen_ai.request.model')).toBe('gpt-5.4');
    expect(tool?.parentSpanId).toBe(run?.spanId);
    expect(attribute(tool, 'gen_ai.tool.call.arguments')).toBe('{"text":"[redacted]"}');
    expect(attribute(tool, 'gen_ai.tool.call.result')).toBe('echo: [redacted]');
    // The sub-agent's run belongs to the delegate call that started it, in the same trace.
    expect(child?.parentSpanId).toBe(delegate?.spanId);
    expect(child?.traceId).toBe(run?.traceId);
    expect(chats.filter((span) => span.parentSpanId === child?.spanId)).toHaveLength(1);
  });

  it("records the session's intent and the pull requests and commits a run produced", async () => {
    const { fetch, spans } = collector();
    const tracer = new OtelTracer({ endpoint: 'http://collector:4318', fetch });
    const base = { sessionId: 's1', agentId: 'main' };
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    tracer.record({ ...base, timestamp: 1, type: 'run.start', input: 'Fix it', intent: 'build' });
    tracer.record({
      ...base,
      timestamp: 2,
      type: 'link',
      kind: 'commit',
      ref: 'abc123',
      title: 'Fix it',
    });
    tracer.record({
      ...base,
      timestamp: 3,
      type: 'link',
      kind: 'pull_request',
      ref: 'https://github.com/a/b/pull/1',
    });
    tracer.record({
      ...base,
      timestamp: 4,
      type: 'run.end',
      stopReason: 'end_turn',
      usage,
      turns: 1,
    });
    await tracer.shutdown();

    const [run] = spans();
    expect(attribute(run, 'heaw.intent')).toBe('build');
    expect(run?.events.map((event) => event.name)).toEqual(['heaw.link', 'heaw.link']);
  });

  it('reads the standard OTEL variables', () => {
    expect(telemetryFromEnv({})).toBeUndefined();
    expect(
      telemetryFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%3D,other = 1',
        OTEL_SERVICE_NAME: 'my-agent',
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true',
      }),
    ).toEqual({
      endpoint: 'http://localhost:4318',
      headers: { 'x-api-key': 'abc=', other: '1' },
      serviceName: 'my-agent',
      captureContent: true,
    });
    expect(
      telemetryFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b/v1/traces',
      })?.endpoint,
    ).toBe('http://b/v1/traces');
  });

  it('reports a collector it cannot reach, without failing the run', async () => {
    const engine = await createEngine({
      model: new ScriptedModelClient([{ text: 'ok' }]),
      toolsets: [],
      telemetry: {
        endpoint: 'http://collector:4318',
        fetch: () => Promise.reject(new Error('connection refused')),
      },
    });

    const events = await collect(engine.session().send('hi'));
    await engine.dispose();

    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'end_turn' });
    expect(engine.telemetryError).toBe('http://collector:4318/v1/traces: connection refused');
  });
});

describe('secret redaction', () => {
  it('finds secrets by name and by what the config reads, and replaces them', () => {
    const secrets = secretsFromEnv(
      {
        AZURE_OPENAI_API_KEY: 'azure-key-0123456789',
        GITHUB_TOKEN: 'ghp_abcdefghijklmnop',
        JIRA_SITE: 'mycompany-site-value',
        SHORT_TOKEN: 'abc',
        PATH: '/usr/bin:/bin',
      },
      referencedVariables([{ apiKey: env('JIRA_SITE') }, { url: 'https://${MISSING_VAR}/x' }]),
    );
    const redactor = new Redactor(secrets);

    expect(secrets.sort()).toEqual([
      'abc',
      'azure-key-0123456789',
      'ghp_abcdefghijklmnop',
      'mycompany-site-value',
    ]);
    expect(
      redactor.redact(
        'key=azure-key-0123456789 token ghp_abcdefghijklmnop on mycompany-site-value, abc',
      ),
    ).toBe('key=[redacted] token [redacted] on [redacted], abc');
  });

  it('keeps secrets out of saved sessions', async () => {
    const root = await tempDir();
    const store = new JsonlSessionStore(root, {
      redact: (text) => new Redactor(['s3cr3t-value"x']).redact(text),
    });

    await store.append('s1', [
      {
        type: 'message',
        timestamp: 0,
        message: { role: 'user', content: [{ type: 'text', text: 'my key is s3cr3t-value"x' }] },
      },
    ]);

    const [record] = await store.load('s1');
    expect(record).toMatchObject({ message: { content: [{ text: 'my key is [redacted]' }] } });
  });
});
