/**
 * Provider-specific data attached to a message part (e.g. reasoning item ids or encrypted
 * reasoning). Opaque to the core: the adapter that produced it reads it back on the next call.
 */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

export interface TextPart {
  type: 'text';
  text: string;
  providerMetadata?: ProviderMetadata;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  providerMetadata?: ProviderMetadata;
}

export interface ToolCallPart {
  type: 'tool-call';
  id: string;
  name: string;
  args: unknown;
  providerMetadata?: ProviderMetadata;
}

export interface ToolResultPart {
  type: 'tool-result';
  callId: string;
  name: string;
  /** The result as text; images are also described here, for models that cannot see them. */
  output: string;
  isError?: boolean;
  /** Images that come with the result, such as a screenshot of a page. Never saved. */
  images?: ToolImage[];
}

/** An image in a tool result: base64 data and its media type, e.g. `image/png`. */
export interface ToolImage {
  mediaType: string;
  data: string;
}

/** The message without the images of its tool results. */
export function withoutImages(message: Message): Message {
  if (message.role !== 'tool' || !message.content.some((part) => part.images)) return message;
  return {
    ...message,
    content: message.content.map(textOnly),
  };
}

function textOnly(part: ToolResultPart): ToolResultPart {
  if (!part.images) return part;
  const copy = { ...part };
  delete copy.images;
  return copy;
}

/**
 * The history with images only in the `keep` latest tool results that have any: each costs
 * about a thousand tokens on every later call, and an old screenshot shows a page as it was.
 * Their descriptions stay in the text.
 */
export function withRecentImages(messages: readonly Message[], keep: number): Message[] {
  let kept = 0;
  const result: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'tool' || !message.content.some((part) => part.images?.length)) {
      result.push(message);
      continue;
    }
    const content = message.content.map((part) => {
      if (!part.images?.length) return part;
      return kept++ < keep ? part : textOnly(part);
    });
    result.push({ ...message, content });
  }
  return result.reverse();
}

export interface UserMessage {
  role: 'user';
  content: TextPart[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: Array<TextPart | ReasoningPart | ToolCallPart>;
}

export interface ToolMessage {
  role: 'tool';
  content: ToolResultPart[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export function userMessage(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * Notes from heaw itself (near a limit, going in circles, the turn limit reached), each starting
 * with `heaw:`, as a message of their own after the tool results: the model is told that what
 * tools return is data, not instructions, and a note at the end of a result read as part of it.
 */
export function heawNote(notes: string[]): UserMessage {
  return userMessage(notes.map((note) => `[${note}]`).join('\n\n'));
}

export function isHeawNote(message: Message): boolean {
  return message.role === 'user' && textOf(message).startsWith('[heaw: ');
}

/** The message without tool calls a provider sent although none were allowed. */
export function withoutToolCalls(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter((part) => part.type !== 'tool-call') };
}

/** The concatenated text parts of a message, without reasoning. */
export function textOf(message: Message): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The text of the last assistant message that has any: an agent's final answer. */
export function lastAnswer(messages: readonly Message[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = textOf(message).trim();
    if (text) return text;
  }
  return '';
}

export function toolCallsOf(message: AssistantMessage): ToolCallPart[] {
  return message.content.filter((part): part is ToolCallPart => part.type === 'tool-call');
}
