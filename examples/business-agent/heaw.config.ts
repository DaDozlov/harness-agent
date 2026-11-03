import { defineConfig, env } from 'harness-engineered-agentic-workflow';

const SHOP_API = 'http://localhost:4010';
const MAX_REFUND_EUR = 100;

/**
 * A customer support agent for a shop. It works only through the shop's API and the policies in
 * its skills: no shell, no files, no web.
 */
export default defineConfig({
  model: 'azure:gpt-5.4',

  toolsets: ['http', 'skills', 'todo'],
  http: {
    apis: {
      [SHOP_API]: {
        // The model sees this: the routes save it from guessing.
        description:
          'The shop. GET /customers?email={email}, GET /customers/{id}/orders, ' +
          'GET /orders/{orderId}, GET /refunds?orderId={orderId}, POST /refunds',
        // Added to every request; the model never sees the token.
        headers: { Authorization: env('SHOP_API_TOKEN', { prefix: 'Bearer ' }) },
      },
    },
  },

  permissions: {
    mode: 'default',
    // Looking things up needs no approval; issuing a refund is asked about.
    allow: [`http_request(GET ${SHOP_API})`],
    ask: [`http_request(POST ${SHOP_API})`],
    deny: ['http_request(PUT *)', 'http_request(PATCH *)', 'http_request(DELETE *)'],
  },

  limits: { maxTurns: 30, maxCostUsd: 0.5 },

  hooks: {
    // A business rule in code, not in the prompt: large refunds go to a person.
    beforeToolCall({ tool, args }) {
      if (tool !== 'http_request') return undefined;
      const { method, url, json } = args as { method?: string; url: string; json?: unknown };
      const amount = (json as { amount?: unknown } | undefined)?.amount;
      if (method !== 'POST' || !url.startsWith(`${SHOP_API}/refunds`)) return undefined;
      if (typeof amount === 'number' && amount <= MAX_REFUND_EUR) return undefined;
      return {
        block:
          `Refunds over €${MAX_REFUND_EUR} need a person. Tell the customer that a colleague ` +
          'will confirm the refund within one working day; do not promise the amount.',
      };
    },
  },
});
