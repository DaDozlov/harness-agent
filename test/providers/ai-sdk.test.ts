import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelStreamEvent } from '../../src/core/model.js';
import {
  AiSdkModelClient,
  RepeatFilter,
  takesImagesInToolResults,
  toCallOptions,
  toPrompt,
} from '../../src/providers/ai-sdk.js';
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

  it('retries a response the server or the connection cut off half way', async () => {
    // What the OpenAI-compatible provider (Ollama) reports when the stream stops early.
    const cut = new InvalidResponseDataError({
      data: undefined,
      message: 'Response stream ended without a finish reason.',
    });
    const dropped = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    for (const error of [cut, new TypeError('terminated'), dropped]) {
      const { client } = fakeModel(() => [{ type: 'error', error }]);
      await expect(collect(client.stream(REQUEST))).rejects.toMatchObject({ retryable: true });
    }
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const { client } = fakeModel(() => [{ type: 'error', error: refused }]);
    await expect(collect(client.stream(REQUEST))).rejects.toMatchObject({ retryable: false });
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

describe('images in tool results', () => {
  const request: ModelRequest = {
    system: '',
    messages: [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            callId: 'c1',
            name: 'mcp__browser__browser_take_screenshot',
            output: '[image, image/png, 3 bytes]',
            images: [{ mediaType: 'image/png', data: 'AAAA' }],
          },
        ],
      },
    ],
  };
  const outputOf = (prompt: ReturnType<typeof toPrompt>) =>
    (prompt[0]?.content as Array<{ output: unknown }>)[0]?.output;

  it('go as images to APIs that take them, and as their description elsewhere', () => {
    expect(outputOf(toPrompt(request, { images: true }))).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '[image, image/png, 3 bytes]' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } },
      ],
    });
    expect(outputOf(toPrompt(request))).toEqual({
      type: 'text',
      value: '[image, image/png, 3 bytes]',
    });
    expect(takesImagesInToolResults('azure.responses')).toBe(true);
    expect(takesImagesInToolResults('openai.responses')).toBe(true);
    expect(takesImagesInToolResults('anthropic.messages')).toBe(true);
    expect(takesImagesInToolResults('openai.chat')).toBe(false);
    expect(takesImagesInToolResults('ollama.chat')).toBe(false);
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

  it('sends the cache key as the prompt cache key of OpenAI and Azure, keeping other options', () => {
    const options = toCallOptions({
      ...REQUEST,
      cacheKey: 's1:ui-builder',
      providerOptions: { openai: { store: false }, anthropic: { x: 1 } },
    });

    expect(options.providerOptions).toEqual({
      openai: { promptCacheKey: 's1:ui-builder', store: false },
      azure: { promptCacheKey: 's1:ui-builder' },
      anthropic: { x: 1 },
    });
    expect(toCallOptions(REQUEST)).not.toHaveProperty('providerOptions');
  });

  it('sends no tool settings when there are no tools', () => {
    const options = toCallOptions({ ...REQUEST, tools: [] });

    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('toolChoice');
  });
});

describe('a final answer that repeats a progress message', () => {
  const text = (id: string, delta: string, phase: string): LanguageModelV4StreamPart[] => [
    { type: 'text-start', id, providerMetadata: { azure: { phase } } },
    { type: 'text-delta', id, delta: delta.slice(0, 6) },
    { type: 'text-delta', id, delta: delta.slice(6) },
    { type: 'text-end', id },
  ];

  it('is shown once, and kept twice in the history', async () => {
    const { client } = fakeModel(() => [
      ...text('a', 'Step 1 is done.', 'commentary'),
      ...text('b', 'Step 1 is done.', 'final_answer'),
      FINISH_STOP,
    ]);

    const events = await collect(client.stream(REQUEST));

    const shown = events.flatMap((event) => (event.type === 'text-delta' ? [event.text] : []));
    expect(shown.join('')).toBe('Step 1 is done.');
    const finish = events.at(-1);
    expect(finish?.type === 'finish' && finish.message.content.map((part) => part.type)).toEqual([
      'text',
      'text',
    ]);
  });

  it('shows a later text that only starts the same way in full', () => {
    const filter = new RepeatFilter();
    filter.delta('a', 'Step 1 is done.');
    filter.end('a');

    expect(filter.delta('b', 'Step 1 ')).toBe('');
    expect(filter.delta('b', 'and 2 are done.')).toBe('Step 1 and 2 are done.');
    expect(filter.delta('b', ' Next: 3.')).toBe(' Next: 3.');
  });
});

describe('a stored item the provider lost', () => {
  const history: ModelRequest = {
    system: 'Be brief.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Build it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerMetadata: { azure: { itemId: 'rs_1' } } },
          {
            type: 'tool-call',
            id: 'call_1',
            name: 'read_file',
            args: { path: 'a.ts' },
            providerMetadata: { azure: { itemId: 'fc_1' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', callId: 'call_1', name: 'read_file', output: 'x' }],
      },
    ],
  };

  it('makes the call again, and every later one, with the history inline', async () => {
    let calls = 0;
    const { client, calls: options } = fakeModel(() => {
      if (calls++ === 0) {
        throw new APICallError({
          message: "Item with id 'rs_1' not found.",
          url: 'https://example.com',
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      }
      return [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        FINISH_STOP,
      ];
    });

    const first = await collect(client.stream(history));
    await collect(client.stream(history));

    expect(first.at(-1)?.type).toBe('finish');
    const ids = (call: LanguageModelV4CallOptions) =>
      JSON.stringify(call.prompt).match(/"itemId"/g)?.length ?? 0;
    expect(options.map(ids)).toEqual([2, 0, 0]);
  });

  it('drops the reasoning effort, from then on, for a model that does not reason', async () => {
    let calls = 0;
    const { client, calls: options } = fakeModel(() => {
      if (calls++ === 0) {
        throw new APICallError({
          message: '"qwen2.5-coder:14b" does not support thinking',
          url: 'http://localhost:11434/v1',
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      }
      return [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        FINISH_STOP,
      ];
    });

    const first = await collect(client.stream({ ...history, reasoningEffort: 'medium' }));
    await collect(client.stream({ ...history, reasoningEffort: 'high' }));

    expect(first.at(-1)?.type).toBe('finish');
    expect(options.map((call) => call.reasoning)).toEqual(['medium', undefined, undefined]);
  });

  it('does not hide other errors', async () => {
    const { client } = fakeModel(() => {
      throw new APICallError({
        message: 'Invalid schema',
        url: 'https://example.com',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    });

    await expect(collect(client.stream(history))).rejects.toMatchObject({ status: 400 });
  });
});
