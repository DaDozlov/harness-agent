import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatContact } from '../public/format.js';

test('shows the name', () => {
  assert.equal(formatContact({ name: 'Ada Lovelace', email: 'ada@example.com' }), 'Ada Lovelace');
});
