// Not part of the fixture: copied into the trial after the agent has finished.
// The plan's four steps are all still there and ticked, and the README shows the usage.
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const plan = readFileSync('PLAN.md', 'utf8');
const steps = [...plan.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gm)];
if (steps.length < 4) fail(`PLAN.md has ${steps.length} steps; it started with 4.`);
const open = steps.filter((step) => step[1] === ' ').map((step) => step[2]);
if (open.length) fail(`PLAN.md still has open steps:\n${open.join('\n')}`);
for (const name of ['remove(id)', 'README.md']) {
  if (!steps.some((step) => step[2].includes(name))) {
    fail(`The step about ${name} is gone from PLAN.md.`);
  }
}

const readme = readFileSync('README.md', 'utf8');
if (!/usage/i.test(readme)) fail('README.md has no "Usage" section.');
for (const name of ['add', 'get', 'list', 'remove']) {
  if (!new RegExp(`\\b${name}\\(`).test(readme)) fail(`README.md does not show ${name}().`);
}
console.log('All steps are ticked and the README shows the four functions.');
