import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.js';

test('slugify follows SPEC.md', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('Straße 5'), 'strasse-5');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('A -- B__C'), 'a-b-c');
  assert.equal(slugify('!!!'), '');
});
