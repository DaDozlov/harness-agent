// Not part of the fixture. A mutation probe: puts src/refunds.js back as it was before the fix
// and runs the project's own tests (the agent's in test/, not the hidden ones). Some must fail
// then, or no test would stop the double refund from coming back.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const fixed = readFileSync('src/refunds.js', 'utf8');
const before = execFileSync('git', ['show', 'HEAD:src/refunds.js'], { encoding: 'utf8' });
writeFileSync('src/refunds.js', before);
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/**/*.test.js'], {
  encoding: 'utf8',
});
writeFileSync('src/refunds.js', fixed);
const output = `${run.stdout}${run.stderr}`;
// A run that found no tests, or did not start, is no evidence either way.
const failed = Number(/^# fail (\d+)/m.exec(output)?.[1] ?? 0);
if (!failed) {
  console.error(
    'With the old src/refunds.js no test fails: none catches a double refund.\n' +
      output.slice(-600),
  );
  process.exit(1);
}
console.log(`With the old src/refunds.js ${failed} test(s) fail: the regression is caught.`);
