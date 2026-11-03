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
  output: string;
  isError?: boolean;
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
