// Not part of the fixture: copied into the trial after the agent has finished.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handle } from '../src/app.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('GET /version answers with the version from package.json', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.deepEqual(handle('GET', '/version'), { status: 200, body: { version } });
});

test('the route is in routes.json, next to the others', () => {
  const routes = JSON.parse(read('routes.json'));
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), [
    'GET /health',
    'GET /users',
    'GET /version',
  ]);
});

test('src/generated/routes.js is what the generator writes from routes.json', () => {
  const before = read('src/generated/routes.js');
  const run = spawnSync(process.execPath, ['tools/generate-routes.js'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(before, read('src/generated/routes.js'), 'the generated file was edited by hand');
});

test('the other routes still work', () => {
  assert.equal(handle('GET', '/health').status, 200);
  assert.equal(handle('GET', '/nowhere').status, 404);
});
