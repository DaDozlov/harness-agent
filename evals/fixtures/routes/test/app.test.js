import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.js';

test('GET /health says the service is up', () => {
  assert.deepEqual(handle('GET', '/health'), { status: 200, body: { ok: true } });
});

test('GET /users lists the users', () => {
  const { status, body } = handle('GET', '/users');
  assert.equal(status, 200);
  assert.deepEqual(
    body.map((user) => user.name),
    ['Ada', 'Grace'],
  );
});

test('unknown routes are not found', () => {
  assert.equal(handle('GET', '/nowhere').status, 404);
  assert.equal(handle('POST', '/health').status, 404);
});
