import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReport } from '../scripts/report.mjs';

test('lists each region and the sum', () => {
  const page = renderReport([
    { region: 'North', total: 1000 },
    { region: 'South', total: 250 },
  ]);
  assert.match(page, /<td>North<\/td><td>1,000<\/td>/);
  assert.match(page, /<th>All<\/th><th>1,250<\/th>/);
});
