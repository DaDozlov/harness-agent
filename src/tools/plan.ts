import { z } from 'zod';
import { archivePlan, PLAN_FILE } from '../core/plan.js';
import type { Tool } from '../core/tools.js';
import { defineTool } from './define.js';

/** How the agent builds an approved plan; also what `/plan go` asks for. */
export const BUILD_INSTRUCTIONS =
  `Build it now as the plan-work skill says: all steps, one after the other, in this turn. For ` +
  `each, implement it, run its check and the project's checks, tick its box in ${PLAN_FILE} ` +
  '(also when you keep a todo list), and go straight on to the next without asking. Stop early ' +
  'only if the plan turns out to be wrong or you need something only the user can give.';

/**
 * `start_plan`: the agent decides a task needs proper planning and switches to plan mode itself
 * (docs/DESIGN.md §4.8). It only restricts what the agent may do, so nobody is asked.
 */
export const startPlan = defineTool({
  name: 'start_plan',
  description:
    `Switch to plan mode before building something bigger than a few files or with real design ` +
    `choices: you can then read everything, write only ${PLAN_FILE}, and you think harder. Then ` +
    `load the plan-work skill and follow it, and call finish_plan when ${PLAN_FILE} is ready. ` +
    'Not for small, clear tasks.',
  kind: 'read',
  parameters: z.object({
    reason: z.string().describe('Why this task needs a plan, in one sentence, for the user'),
  }),
  subject: (args) => args.reason,
  async run(_args, { agent, workspace }) {
    if (!agent?.plan) return { output: 'Only the main agent can plan.', isError: true };
    if (agent.plan.active()) return 'Plan mode is already on.';
    agent.plan.enter();
    const archived = await archivePlan(workspace);
    return (
      `Plan mode is on: read everything, write only ${PLAN_FILE}, no commands. Load the ` +
      `plan-work skill and follow it now; when ${PLAN_FILE} is ready, call finish_plan.` +
      (archived ? ` The previous plan was moved to ${archived}.` : '')
    );
  },
});

/**
 * `finish_plan`: asks the user to approve the plan; always asked, even in plan mode's read-only.
 * Approved, plan mode ends and the agent builds; denied with feedback, it revises the plan.
 */
export const finishPlan = defineTool({
  name: 'finish_plan',
  description:
    `Ask the user to approve ${PLAN_FILE} once it is written. If they approve, plan mode ends ` +
    `and you build all of it in this same turn; if not, revise ${PLAN_FILE} as they say and ` +
    'call this again.',
  kind: 'read',
  alwaysAsk: true,
  parameters: z.object({
    summary: z
      .string()
      .describe(
        'Two or three lines for the user: the main design choice, the steps, the biggest risk',
      ),
  }),
  subject: (args) => args.summary,
  // Before the user is asked: approving a plan that does not exist helps nobody.
  async precheck(_args, { agent, workspace }) {
    if (!agent?.plan?.active()) return 'Plan mode is not on.';
    if (await workspace.stat(PLAN_FILE)) return undefined;
    return (
      `There is no ${PLAN_FILE} yet, so there is nothing to approve. Follow the plan-work skill: ` +
      'ask the user the questions whose answers change the design and wait for their answers, ' +
      `then write ${PLAN_FILE} with write_file (goal, requirements, design, risks, tests, steps ` +
      'with checks), and only then call finish_plan.'
    );
  },
  run(_args, { agent }) {
    if (!agent?.plan?.active()) return { output: 'Plan mode is not on.', isError: true };
    agent.plan.leave();
    agent.plan.build();
    return `The user approved ${PLAN_FILE}, and plan mode is off. ${BUILD_INSTRUCTIONS}`;
  },
});

export const PLAN_TOOLS: Tool[] = [startPlan, finishPlan];
