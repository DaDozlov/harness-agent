// Fails while the old field name is left anywhere in the code or tests, or when the database
// column was renamed too.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const left = [];
for (const dir of ['src', 'test']) {
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    const count = text.split('customerName').length - 1;
    if (count) left.push(`${dir}/${file} (${count})`);
  }
}
const db = readFileSync('src/db.js', 'utf8');
const problems = [
  ...(left.length ? [`customerName is still in ${left.join(', ')}`] : []),
  ...(/'customer_name'/.test(db) ? [] : ['the database column customer_name was renamed']),
];
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Renamed everywhere; the column is unchanged.');
