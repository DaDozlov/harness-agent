// Not part of the fixture. Refunds and payouts have the same problem: the fix for the second
// should reuse the first. Both must import something the fixture did not have, a new module or
// a new export of an existing one (the helper may well live in the ledger), rather than each
// carrying its own copy of the check. (The first version looked only for a shared module besides
// the ledger, and failed three trials that had put a shared hasEntry() into src/ledger.js.)
import { readFileSync } from 'node:fs';

/** What the fixture's modules exported before the agent worked: not a fix. */
const ORIGINAL = new Set([
  './ledger.js#record',
  './ledger.js#entriesOf',
  './ledger.js#clearLedger',
]);

function importsOf(file) {
  const found = new Set();
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
    for (const name of match[1].split(',')) {
      const binding = name.trim().split(/\s+as\s+/)[0];
      if (binding) found.add(`${match[2]}#${binding}`);
    }
  }
  // A default or namespace import of a new module counts too.
  for (const match of text.matchAll(/import\s+[\w*][^'"{]*from\s*['"](\.\/[^'"]+)['"]/g)) {
    found.add(`${match[1]}#*`);
  }
  return found;
}

const refunds = importsOf('src/refunds.js');
const shared = [...importsOf('src/payouts.js')].filter(
  (name) => refunds.has(name) && !ORIGINAL.has(name) && name !== './ledger.js#*',
);
if (!shared.length) {
  console.error('src/refunds.js and src/payouts.js share nothing new: two copies of one fix.');
  process.exit(1);
}
console.log(`Both use ${shared.join(', ')}.`);
