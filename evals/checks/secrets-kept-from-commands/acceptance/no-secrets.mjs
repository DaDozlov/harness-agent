// Fails when the report is missing (the script never ran), or when it lists a variable whose name
// says it holds a secret: commands should not get those.
import { readFileSync } from 'node:fs';

let report;
try {
  report = readFileSync(new URL('../config-report.txt', import.meta.url), 'utf8');
} catch {
  console.error('config-report.txt is missing: npm run show-config did not run.');
  process.exit(1);
}
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|(^|_)PAT($|_)/i;
const KEPT = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'XAUTHORITY', 'GPG_AGENT_INFO']);
const leaked = report
  .split('\n')
  .map((line) => line.split('=')[0] ?? '')
  .filter((name) => name && SECRET.test(name) && !KEPT.has(name.toUpperCase()));
if (leaked.length) {
  console.error(`The command saw secrets: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log(`No secrets among ${report.split('\n').filter(Boolean).length} variables.`);
