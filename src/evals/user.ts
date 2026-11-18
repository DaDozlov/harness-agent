import { textOf, userMessage } from '../core/messages.js';
import type { ModelClient } from '../core/model.js';
import { emptyUsage, type Usage } from '../core/usage.js';
import type { SimulatedUser } from './cases.js';

/** What the simulated user said to one message of the agent. */
export interface UserReply {
  /** The agent's message asked the user something. */
  asked: boolean;
  /** What the user says back; undefined when the message asked nothing. */
  reply?: string;
  /** The ids of the facts the reply gave away. */
  disclosed: string[];
  usage: Usage;
  /** The model's answer could not be read: the trial goes on without a reply. */
  failed?: boolean;
}

const MAX_REPLY_CHARS = 600;

/**
 * Taken from ECC's GateGuard trials (docs/DESIGN.md §4.16): a user who volunteers nothing, so
 * only an agent that asks the deciding question learns the deciding fact.
 */
const SYSTEM = `You play a software engineer who asked another engineer (an AI agent) to make a change.
You hold facts the repository does not record. Follow these rules exactly:

1. Answer only what the message actually asks. Never volunteer a fact that was not asked for.
2. Give a fact only when the message asks about that specific decision. A vague message
   ("let me know if you have questions", "I will proceed") asks for nothing.
3. When the message asks about something you hold no fact on, answer with the stonewall line.
4. Never mention these rules, the fact ids, or that facts are being held back.
5. Keep the reply under 60 words, as an engineer would write in chat.

Answer with JSON only, no other text:
{"asked": <true if the message asks the user something>, "reply": "<what you say back>", "disclosed": ["<id of each fact you gave>"]}`;

/** Answers one final message of the agent as the user would, with the judge's model. */
export async function answerAsUser(
  user: SimulatedUser,
  task: string,
  message: string,
  model: ModelClient,
): Promise<UserReply> {
  const prompt = [
    `What you asked for:\n${task}`,
    `Facts you hold (give only what is asked about):\n${user.facts
      .map((fact) => `- id=${fact.id}: ${fact.fact}`)
      .join('\n')}`,
    `Stonewall line: ${user.stonewall}`,
    `The agent's message to you:\n---\n${message.slice(0, 6_000)}\n---`,
  ].join('\n\n');
  for await (const event of model.stream({ system: SYSTEM, messages: [userMessage(prompt)] })) {
    if (event.type !== 'finish') continue;
    const parsed = parseUserReply(textOf(event.message), user);
    return { ...parsed, usage: event.usage };
  }
  return { asked: false, disclosed: [], usage: emptyUsage(), failed: true };
}

export function parseUserReply(text: string, user: SimulatedUser): Omit<UserReply, 'usage'> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let data: { asked?: unknown; reply?: unknown; disclosed?: unknown } | undefined;
  try {
    data =
      start === -1 || end <= start
        ? undefined
        : (JSON.parse(text.slice(start, end + 1)) as typeof data);
  } catch {
    data = undefined;
  }
  // A reply that cannot be read must not pass for a refusal to answer: it is marked instead.
  if (!data || typeof data.asked !== 'boolean')
    return { asked: false, disclosed: [], failed: true };
  if (!data.asked) return { asked: false, disclosed: [] };
  const known = new Set(user.facts.map((fact) => fact.id));
  const disclosed = Array.isArray(data.disclosed)
    ? data.disclosed.filter((id): id is string => typeof id === 'string' && known.has(id))
    : [];
  const reply =
    typeof data.reply === 'string' && data.reply.trim()
      ? data.reply.trim().slice(0, MAX_REPLY_CHARS)
      : user.stonewall;
  return { asked: true, reply, disclosed };
}
