// Fails while a rule for the contact list keeps entries on one line and hides what does not fit:
// a long email is then cut off in the narrow column.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const problems = [];
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  if (!/#list|\bli\b/.test(selector)) continue;
  const oneLine = /white-space\s*:\s*nowrap/.test(body);
  const hides = /overflow(-x)?\s*:\s*(hidden|clip)|text-overflow\s*:/.test(body);
  if (oneLine && hides) problems.push(selector.trim());
}
if (problems.length) {
  console.error(`Entries are still cut off by: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('Nothing cuts the contact entries off.');
