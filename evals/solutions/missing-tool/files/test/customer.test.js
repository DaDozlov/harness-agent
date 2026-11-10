import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCustomer } from '../src/customer.js';

const ada = { id: 1, name: 'Ada', email: 'ada@example.com' };

test('a complete customer is valid', () => {
  assert.deepEqual(validateCustomer(ada), []);
});

test('each broken field is reported', () => {
  assert.deepEqual(validateCustomer({ id: 1.5, name: '', email: 'nowhere' }), [
    'id must be a whole number',
    'name is required',
    'email must be an email address',
  ]);
});

test('unknown fields are reported', () => {
  assert.deepEqual(validateCustomer({ ...ada, nickname: 'Countess' }), ['unknown field: nickname']);
});

test('a phone number is optional, and text when given', () => {
  assert.deepEqual(validateCustomer({ ...ada, phone: '+49 30 1234567' }), []);
  assert.deepEqual(validateCustomer({ ...ada, phone: 42 }), ['phone must be text']);
});
