import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelStreamEvent } from '../../src/core/model.js';
import { AiSdkModelClient, toCallOptions, toPrompt } from '../../src/providers/ai-sdk.js';
import { DEFAULT_CAPABILITIES } from '../../src/providers/catalog.js';

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

const FINISH_STOP: LanguageModelV4StreamPart = {
  type: 'finish',
  usage: USAGE,
  finishReason: { unified: 'stop', raw: 'stop' },
};

const REQUEST: ModelRequest = { system: 'Be brief.', messages: [] };

function fakeModel(respond: () => LanguageModelV4StreamPart[]) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not used')),
    doStream: (options) => {
      calls.push(options);
      try {
        const parts = respond();
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { client: new AiSdkModelClient('fake:fake-model', model, DEFAULT_CAPABILITIES), calls };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('AiSdkModelClient', () => {
  it('streams deltas and assembles the message, merging provider metadata', async () => {
    const { client } = fakeModel(() => [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1' } } },
      { type: 'reasoning-delta', id: 'r1', delta: 'Thinking' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { openai: { encrypted: 'enc' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hel' },
      { type: 'text-delta', id: 't1', delta: 'lo' },
      { type: 'text-end', id: 't1', providerMetadata: { openai: { itemId: 'msg_1' } } },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: '{"path":"a.ts"}' },
      { type: 'finish', usage: USAGE, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
    ]);

    const events = await collect(client.stream(REQUEST));

    expect(events.slice(0, 3)).toEqual([
      { type: 'reasoning-delta', text: 'Thinking' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
    ]);
    expect(events[3]).toEqual({
      type: 'finish',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Thinking',
            providerMetadata: { openai: { itemId: 'rs_1', encrypted: 'enc' } },
          },
          { type: 'text', text: 'Hello', providerMetadata: { openai: { itemId: 'msg_1' } } },
          { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
        ],
      },
      finishReason: 'tool-calls',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  });

  it('keeps empty reasoning that carries metadata and drops empty text', async () => {
    const { client } = fakeModel(() => [
      { type: 'reasoning-start', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1' } } },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-end', id: 't1' },
      FINISH_STOP,
    ]);

    const [finish] = await collect(client.stream(REQUEST));

    expect(finish).toMatchObject({
      message: {
        content: [
          { type: 'reasoning', text: '', providerMetadata: { openai: { itemId: 'rs_1' } } },
        ],
      },
    });
  });

  it('keeps tool arguments that are not valid JSON as a string', async () => {
    const { client } = fakeModel(() => [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: 'not json' },
      FINISH_STOP,
    ]);

    const [finish] = await collect(client.stream(REQUEST));

    expect(finish).toMatchObject({ message: { content: [{ args: 'not json' }] } });
  });

  it('turns rate limits into retryable model errors with the server-requested delay', async () => {
    const { client } = fakeModel(() => {
      throw new APICallError({
        message: 'Rate limit reached',
        url: 'https://example.com',
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { 'retry-after': '2' },
        isRetryable: true,
      });
    });

    await expect(collect(client.stream(REQUEST))).rejects.toMatchObject({
      name: 'ModelError',
      message: 'Rate limit reached',
      retryable: true,
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it('prefers retry-after-ms and marks auth errors as not retryable', async () => {
    const { client } = fakeModel(() => {
      throw new APICallError({
        message: 'Access denied',
        url: 'https://example.com',
        requestBodyValues: {},
        statusCode: 401,
        responseHeaders: { 'retry-after-ms': '150', 'retry-after': '9' },
        isRetryable: false,
      });
    });

    await expect(collect(client.stream(REQUEST))).rejects.toMatchObject({
      retryable: false,
      status: 401,
      retryAfterMs: 150,
    });
  });

  it('turns an error part in the stream into a model error', async () => {
    const { client } = fakeModel(() => [
      { type: 'error', error: { message: 'Server overloaded' } },
    ]);

    await expect(collect(client.stream(REQUEST))).rejects.toMatchObject({
      name: 'ModelError',
      message: 'Server overloaded',
      retryable: false,
    });
  });

  it('fails with a retryable error when the stream ends without finishing', async () => {
    const { client } = fakeModel(() => [{ type: 'text-delta', id: 't1', delta: 'Hi' }]);

    const stream = client.stream(REQUEST);

    await expect(collect(stream)).rejects.toMatchObject({ retryable: true });
  });
});

describe('toPrompt', () => {
  it('converts the history and sends provider metadata back as provider options', () => {
    const prompt = toPrompt({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '', providerMetadata: { openai: { itemId: 'rs_1' } } },
            { type: 'text', text: 'Reading it.' },
            { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', callId: 'c1', name: 'read_file', output: 'export {}' },
            { type: 'tool-result', callId: 'c2', name: 'x', output: 'Not found', isError: true },
          ],
        },
      ],
    });

    expect(prompt).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1' } } },
          { type: 'text', text: 'Reading it.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read_file',
            output: { type: 'text', value: 'export {}' },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'x',
            output: { type: 'error-text', value: 'Not found' },
          },
        ],
      },
    ]);
  });

  it('leaves out an empty system prompt', () => {
    expect(toPrompt({ system: '', messages: [] })).toEqual([]);
  });
});

describe('toCallOptions', () => {
  it('passes tools, settings and the abort signal', () => {
    const signal = new AbortController().signal;
    const options = toCallOptions(
      {
        ...REQUEST,
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
        maxOutputTokens: 1000,
        reasoningEffort: 'low',
      },
      signal,
    );

    expect(options).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
      ],
      toolChoice: { type: 'auto' },
      maxOutputTokens: 1000,
      reasoning: 'low',
      abortSignal: signal,
    });
  });

  it('sends no tool settings when there are no tools', () => {
    const options = toCallOptions({ ...REQUEST, tools: [] });

    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('toolChoice');
  });
});
