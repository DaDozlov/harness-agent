import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { createProgram } from '../../src/cli/program.js';

function run(args: string[]) {
  let output = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({ writeOut: (text) => (output += text) });
  const result = program.parseAsync(args, { from: 'user' });
  return { result, output: () => output };
}

describe('heaw CLI', () => {
  it('prints the version with --version', async () => {
    const { result, output } = run(['--version']);
    await expect(result).rejects.toMatchObject({ code: 'commander.version' });
    expect(output().trim()).toBe(pkg.version);
  });

  it('prints help with --help', async () => {
    const { result, output } = run(['--help']);
    await expect(result).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    expect(output()).toContain('Usage: heaw');
  });
});
