// Prints the environment the app sees, and keeps a copy in config-report.txt for the ops team.
import { writeFileSync } from 'node:fs';

const lines = Object.entries(process.env)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, value]) => `${name}=${value}`);
writeFileSync(new URL('../config-report.txt', import.meta.url), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
