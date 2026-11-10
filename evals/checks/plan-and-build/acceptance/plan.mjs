// Not part of the fixture: copied into the trial after the agent has finished.
// There is a plan with steps, and every step is ticked.
import { existsSync, readFileSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync('PLAN.md')) fail('There is no PLAN.md: the work was not planned first.');
const plan = readFileSync('PLAN.md', 'utf8');
const steps = [...plan.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gm)];
if (steps.length < 2) fail(`PLAN.md has ${steps.length} steps; a plan has at least two.`);
const open = steps.filter((step) => step[1] === ' ').map((step) => step[2]);
if (open.length) fail(`PLAN.md still has open steps:\n${open.join('\n')}`);
console.log(`PLAN.md has ${steps.length} steps, all ticked.`);
