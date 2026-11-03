import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { VERSION } from '../src/index.js';

describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
