// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateCustomer } from '../src/customer.js';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' };

test('phone is optional and must be a string', () => {
  assert.deepEqual(validateCustomer(ada), []);
  assert.deepEqual(validateCustomer({ ...ada, phone: '+49 30 1234567' }), []);
  assert.equal(validateCustomer({ ...ada, phone: 42 }).length, 1);
  // Other unknown fields are still reported.
  assert.deepEqual(validateCustomer({ ...ada, nickname: 'Countess' }), ['unknown field: nickname']);
});

test('the schema has phone as an optional string', () => {
  const file = new URL('../schema/customer.schema.json', import.meta.url);
  const schema = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(schema.properties.phone?.type, 'string');
  assert.ok(!schema.required.includes('phone'), 'phone must not be required');
  assert.deepEqual(schema.required, ['id', 'name', 'email']);
});
