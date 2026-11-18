import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import {
  codeRunningFiles,
  isTrusted,
  trustProject,
  trustQuestion,
} from '../../src/config/trust.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();

describe('trusting a project', () => {
  it('names the files that run code, and remembers the folders the user trusted', async () => {
    const home = await tempDir();
    const project = await tempDir();
    expect(codeRunningFiles(project)).toEqual([]);

    await writeFile(join(project, 'heaw.config.ts'), 'export default {};');
    await writeFile(join(project, '.mcp.json'), '{"mcpServers": {}}');
    expect(codeRunningFiles(project)).toEqual(['heaw.config.ts', '.mcp.json']);
    expect(trustQuestion(project, codeRunningFiles(project))).toContain(
      'has heaw.config.ts and .mcp.json. Loading them runs code on this machine',
    );

    expect(isTrusted(home, project)).toBe(false);
    trustProject(home, project);
    trustProject(home, project);
    expect(isTrusted(home, project)).toBe(true);
    // The same folder, spelled another way.
    expect(isTrusted(home, join(project, 'sub', '..'))).toBe(true);
    expect(isTrusted(home, await tempDir())).toBe(false);
  });

  it('trusts the folder heaw init made a setup in', async () => {
    const home = await tempDir();
    const project = await tempDir();

    await initCommand(
      { model: 'azure:x' },
      { cwd: project, env: { HEAW_HOME: home }, stdout: { write: () => true } },
    );

    expect(isTrusted(home, project)).toBe(true);
  });
});
