/**
 * A terminal chat in about 60 lines: the engine streams events, the script prints them and asks
 * the user about tool calls that need approval.
 *
 *   node --env-file-if-exists=.env chat.ts
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  createEngine,
  type ApprovalDecision,
  type EngineEvent,
} from 'harness-engineered-agentic-workflow';

const engine = await createEngine({
  model: process.env.HEAW_MODEL ?? 'azure:gpt-5.4',
  // Reading needs no approval in the default mode; edits and commands are asked about.
  permissions: { mode: 'default', deny: ['read_file(**/.env*)'] },
  limits: { maxTurns: 50, maxCostUsd: 2 },
});
const session = engine.session();
const terminal = createInterface({ input: stdin, output: stdout });

async function decide(event: Extract<EngineEvent, { type: 'approval.request' }>) {
  const answer = await terminal.question(
    `\nAllow ${event.tool} ${event.subject ?? ''}? [y]es, [a]lways, [n]o: `,
  );
  const decisions: Record<string, ApprovalDecision> = {
    y: { allow: true, scope: 'once' },
    a: { allow: true, scope: 'session' },
  };
  return decisions[answer.trim().toLowerCase()] ?? { allow: false };
}

try {
  for (;;) {
    const input = (await terminal.question('\n> ')).trim();
    if (input === '' || input === '/exit') break;

    for await (const event of session.send(input)) {
      // Sub-agents ask too, and the run waits for the answer.
      if (event.type === 'approval.request') session.approve(event.requestId, await decide(event));
      // Their other events are left out here.
      if (event.parentAgentId) continue;
      if (event.type === 'text.delta') stdout.write(event.text);
      if (event.type === 'tool.start') stdout.write(`\n· ${event.tool} `);
      if (event.type === 'tool.end') stdout.write(`${event.status}\n`);
      if (event.type === 'run.end') {
        const cost = event.costUsd === undefined ? '' : ` · $${event.costUsd.toFixed(3)}`;
        stdout.write(`\n(${event.stopReason} · ${event.turns} turns${cost})\n`);
      }
    }
  }
} finally {
  terminal.close();
  await engine.dispose();
  await engine.workspace.dispose();
}
