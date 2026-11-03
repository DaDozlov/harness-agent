import type { HookContext, HookFailure, HookRunner } from './hooks.js';
import { type Message, textOf, userMessage } from './messages.js';
import type { ModelCapabilities, ModelClient, ModelRequest } from './model.js';
import { emptyUsage, type Usage } from './usage.js';

/** Starts the user message that carries a summary, so UIs can show it as one. */
export const SUMMARY_PREFIX = 'The earlier part of this conversation was summarized';

const CLEARED_OUTPUT = '[Output cleared to save context. Run the tool again if you need it.]';
/** Tool results in the most recent turns stay, since the model is still working with them. */
const KEEP_TOOL_RESULTS = 4;
/** Outputs shorter than this are not worth clearing. */
const CLEARABLE_CHARS = 300;
/** Share of the usable window that the most recent turns may keep after a summary. */
const KEEP_RECENT_SHARE = 0.25;
/** …and at most this share of the history as it was. */
const KEEP_RECENT_SHARE_OF_HISTORY = 0.3;
/** Summarizing less than this saves nothing. */
const MIN_SUMMARIZED_TOKENS = 1_000;

/** About four characters per token; `ContextMeter` corrects this per provider. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A raw estimate of a request's input tokens: system prompt, tool schemas and history. */
export function estimateRequest(request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>) {
  const tools = request.tools ? JSON.stringify(request.tools) : '';
  return (
    estimateTokens(request.system) +
    estimateTokens(tools) +
    request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)
  );
}

function estimateMessage(message: Message): number {
  let chars = 0;
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'reasoning') chars += part.text.length;
    else if (part.type === 'tool-call')
      chars += part.name.length + JSON.stringify(part.args).length;
    else if (part.type === 'tool-result') chars += part.output.length;
  }
  // Roles and separators cost a few tokens per message.
  return Math.ceil(chars / 4) + 4;
}

/**
 * Estimates the tokens of the next request. Learns from each call how the provider's count
 * compares to the raw estimate, so code, prose and other languages come out about right.
 */
export class ContextMeter {
  #ratio = 1;

  calibrate(request: ModelRequest, inputTokens: number): void {
    const estimate = estimateRequest(request);
    if (estimate > 0 && inputTokens > 0) {
      this.#ratio = Math.min(3, Math.max(0.5, inputTokens / estimate));
    }
  }

  measure(request: Pick<ModelRequest, 'system' | 'messages' | 'tools'>): number {
    return Math.round(estimateRequest(request) * this.#ratio);
  }
}

/** Input tokens a request may use: the window minus room for the longest answer. */
export function usableWindow(capabilities: ModelCapabilities): number {
  return Math.max(1_000, capabilities.contextWindow - capabilities.maxOutputTokens);
}

export interface CompactOptions {
  messages: readonly Message[];
  model: ModelClient;
  meter: ContextMeter;
  /** The rest of the request, for measuring: the system prompt and tool schemas. */
  request: Pick<ModelRequest, 'system' | 'tools'>;
  /** `manual` always summarizes; `auto` first tries clearing old tool results. */
  trigger: 'auto' | 'manual';
  /** Clearing tool results is enough when it brings the request below this. */
  target: number;
  /** What the summary should focus on, from `/compact <instructions>`. */
  instructions?: string | undefined;
  hooks: HookRunner;
  hookContext: HookContext;
  signal: AbortSignal;
}

export interface CompactResult {
  messages: Message[];
  method: 'tool-results' | 'summary';
  beforeTokens: number;
  afterTokens: number;
  /** Of the summarizing model call. */
  usage: Usage;
  failures: HookFailure[];
}

/**
 * Shortens the history (docs/DESIGN.md §4.9): clears old tool outputs, and if that is not
 * enough, summarizes older turns with a model call, keeping the most recent turns as they are.
 * Returns undefined when there is nothing to shorten.
 */
export async function compactHistory(options: CompactOptions): Promise<CompactResult | undefined> {
  const measure = (messages: readonly Message[]) =>
    options.meter.measure({ ...options.request, messages: [...messages] });
  const beforeTokens = measure(options.messages);
  const cleared = clearOldToolResults(options.messages);
  const clearedTokens = measure(cleared);

  if (options.trigger === 'auto' && clearedTokens <= options.target) {
    if (clearedTokens >= beforeTokens) return undefined;
    return {
      messages: cleared,
      method: 'tool-results',
      beforeTokens,
      afterTokens: clearedTokens,
      usage: emptyUsage(),
      failures: [],
    };
  }

  // Keep a part of the window, but never most of the conversation, or a summary saves nothing.
  const keepBudget = Math.min(
    usableWindow(options.model.capabilities) * KEEP_RECENT_SHARE,
    beforeTokens * KEEP_RECENT_SHARE_OF_HISTORY,
  );
  const split = splitPoint(cleared, (messages) => measure(messages), keepBudget);
  if (split === undefined) return undefined;

  const older = cleared.slice(0, split);
  // A summary of a short stretch comes out longer than the stretch itself.
  if (measure(older) < MIN_SUMMARIZED_TOKENS) return undefined;
  // Hooks see the whole history, so they can tell what is still current.
  const { preserve, failures } = await options.hooks.beforeCompact(
    options.hookContext,
    options.messages,
  );
  const { summary, usage } = await summarize(older, options);
  const header =
    `${SUMMARY_PREFIX} to fit the context window.\n\n<summary>\n${summary}\n</summary>` +
    (preserve ? `\n\nKept as it was:\n${preserve}` : '');
  const messages: Message[] = [
    userMessage(header),
    // Keeps the roles alternating, which some providers require.
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Understood. I will continue from here.' }],
    },
    ...cleared.slice(split),
  ];
  return {
    messages,
    method: 'summary',
    beforeTokens,
    afterTokens: measure(messages),
    usage,
    failures,
  };
}

/** Replaces long tool outputs outside the most recent turns with a short note. */
export function clearOldToolResults(messages: readonly Message[]): Message[] {
  const toolMessages = messages.flatMap((message, index) =>
    message.role === 'tool' ? [index] : [],
  );
  const keepFrom = toolMessages.at(-KEEP_TOOL_RESULTS) ?? 0;
  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= keepFrom) return message;
    return {
      role: 'tool',
      content: message.content.map((part) =>
        part.output.length > CLEARABLE_CHARS ? { ...part, output: CLEARED_OUTPUT } : part,
      ),
    };
  });
}

/**
 * Where to cut the history: the earliest point whose remainder fits `budget`, at least one
 * message in, and never between a tool call and its result (a remainder cannot start with
 * tool results). Undefined when no such point exists.
 */
function splitPoint(
  messages: readonly Message[],
  measure: (messages: readonly Message[]) => number,
  budget: number,
): number | undefined {
  let fallback: number | undefined;
  for (let index = 1; index < messages.length; index++) {
    if (messages[index]!.role === 'tool') continue;
    if (measure(messages.slice(index)) <= budget) return index;
    fallback = index;
  }
  // Even the latest turn alone is over budget: keep just that.
  return fallback;
}

const SUMMARY_SYSTEM =
  'You compress the history of an AI agent session so the agent can continue the work ' +
  'without it. Write concise notes to the agent that keep: what the user asked for (quote ' +
  'exact instructions and requirements), decisions and why they were made, files read or ' +
  'changed and how, commands run and their outcomes, errors and how they were resolved, the ' +
  'current state of the work, the plan or task list, and the next steps. Leave out greetings ' +
  'and output that no longer matters. Answer with the notes only.';

/** Tool outputs are cut harder until the transcript fits one call. */
const PART_LIMITS = [2_000, 500, 100];

async function summarize(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<{ summary: string; usage: Usage }> {
  const budgetChars = Math.floor(usableWindow(options.model.capabilities) * 0.7 * 4);
  const focus = options.instructions ? `\n\nFocus on: ${options.instructions}` : '';
  const transcript = transcriptWithin(messages, budgetChars - focus.length);
  const request: ModelRequest = {
    system: SUMMARY_SYSTEM,
    messages: [userMessage(`Summarize this session history:${focus}\n\n${transcript}`)],
  };
  for await (const event of options.model.stream(request, options.signal)) {
    if (event.type === 'finish') {
      const summary = textOf(event.message).trim();
      if (!summary) throw new Error('The model returned an empty summary.');
      return { summary, usage: event.usage };
    }
  }
  throw new Error('The summary call ended without an answer.');
}

/**
 * The history as text that fits `budget` characters. The start holds the user's request and the
 * end the latest state, so if cutting tool outputs is not enough, the middle goes.
 */
function transcriptWithin(messages: readonly Message[], budget: number): string {
  let transcript = '';
  for (const limit of PART_LIMITS) {
    transcript = messages.map((message) => render(message, limit)).join('\n\n');
    if (transcript.length <= budget) return transcript;
  }
  const gap = '\n\n[… part of the conversation is left out …]\n\n';
  const head = Math.floor((budget - gap.length) * 0.3);
  return `${transcript.slice(0, head)}${gap}${transcript.slice(-(budget - gap.length - head))}`;
}

function render(message: Message, limit: number): string {
  const cut = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}… [cut]` : text;
  // What people and the agent said matters more than what tools returned.
  if (message.role === 'user') return `User: ${cut(textOf(message), PART_LIMITS[0]!)}`;
  if (message.role === 'tool') {
    return message.content
      .map((part) => `Result of ${part.name}: ${cut(part.output, limit)}`)
      .join('\n');
  }
  return message.content
    .map((part) => {
      if (part.type === 'text') return `Assistant: ${cut(part.text, PART_LIMITS[0]!)}`;
      if (part.type === 'tool-call') {
        return `Assistant called ${part.name}(${cut(JSON.stringify(part.args), limit)})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
