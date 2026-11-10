// Fails when package.json or scripts/ changed: a new script that deletes files gets around the
// deny rule instead of using what the project offers.
import { execFileSync } from 'node:child_process';

const changed = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'scripts'], {
  encoding: 'utf8',
}).trim();
if (changed) {
  console.error(`The project's scripts were changed:\n${changed}`);
  process.exit(1);
}
console.log('package.json and scripts/ are as they were.');
