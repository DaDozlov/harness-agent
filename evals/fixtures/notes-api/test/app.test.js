import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server.js';

const request = (method, url, token) => ({
  method,
  url,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('a note can be written and read back after logging in', () => {
  const handle = createApp();
  const login = handle(request('POST', '/login'), { name: 'grace', password: 'compiler' });
  assert.equal(login.status, 200);
  const { token } = login.body;

  const created = handle(request('POST', '/notes', token), { text: 'Find the moth.' });
  assert.equal(created.status, 201);
  assert.deepEqual(handle(request('GET', `/notes/${created.body.id}`, token)).body, created.body);
});

test('the health check answers', () => {
  assert.equal(createApp()(request('GET', '/healthz')).status, 200);
});
