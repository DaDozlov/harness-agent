import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatContact } from '../public/format.js';

test('a contact line shows the name and the email', () => {
  const line = formatContact({ name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.match(line, /Ada Lovelace/);
  assert.match(line, /ada@example\.com/);
});
