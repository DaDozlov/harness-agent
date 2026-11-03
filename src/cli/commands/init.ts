import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILES, findFile } from '../../config/project.js';
import type { Env } from '../../providers/registry.js';
import type { Output } from './run.js';

export interface InitContext {
  cwd: string;
  env: Env;
  stdout: Output;
}

/** Lines `heaw init` makes sure are in `.gitignore`. */
const IGNORED = ['.env', '.env.*', '!.env.example'];

/**
 * `heaw init`: creates the project layer (docs/DESIGN.md §5) in the current directory:
 * heaw.config.ts, AGENTS.md, .env.example, and .gitignore entries for secrets. Existing files
 * are never overwritten. Returns the exit code.
 */
export async function initCommand(
  options: { model?: string },
  context: InitContext,
): Promise<number> {
  const { cwd, stdout } = context;
  const model = options.model ?? context.env.HEAW_MODEL ?? 'azure:your-deployment-name';
  const report: string[] = [];

  const existingConfig = findFile(cwd, CONFIG_FILES);
  if (existingConfig) {
    report.push(`kept ${existingConfig.slice(cwd.length + 1)} (already exists)`);
  } else {
    const tests = await testCommand(cwd);
    await writeFile(join(cwd, 'heaw.config.ts'), configTemplate(model, tests));
    report.push(
      tests
        ? `created heaw.config.ts (the agent must pass "${tests}" before it may finish)`
        : 'created heaw.config.ts',
    );
  }
  report.push(await createIfMissing(cwd, 'AGENTS.md', AGENTS_TEMPLATE));
  report.push(await createIfMissing(cwd, '.env.example', ENV_TEMPLATE));
  await mkdir(join(cwd, '.heaw', 'agents'), { recursive: true });
  report.push(await createIfMissing(cwd, '.heaw/agents/reviewer.md', REVIEWER_TEMPLATE));
  report.push(await ignoreSecrets(cwd));

  stdout.write(
    [
      `heaw init in ${cwd}`,
      ...report.map((line) => `  ${line}`),
      '',
      'Next:',
      `  1. Put your credentials in .env${existsSync(join(cwd, '.env')) ? '' : ' (copy .env.example)'}.`,
      `  2. Check the model in heaw.config.ts (now ${model}).`,
      '  3. Describe the project in AGENTS.md: what it is, how to build and test it, conventions.',
      '  4. Run heaw.',
      '',
      'More agents go in .heaw/agents/<name>.md; skills in .heaw/skills/<name>/SKILL.md.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function createIfMissing(dir: string, name: string, content: string): Promise<string> {
  if (existsSync(join(dir, name))) return `kept ${name} (already exists)`;
  await writeFile(join(dir, name), content);
  return `created ${name}`;
}

async function ignoreSecrets(dir: string): Promise<string> {
  const path = join(dir, '.gitignore');
  const current = existsSync(path) ? await readFile(path, 'utf8') : '';
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORED.filter((line) => !present.has(line));
  if (!missing.length) return '.gitignore already ignores .env';
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(
    path,
    `${separator}${current ? '\n' : ''}# Secrets (heaw init)\n${missing.join('\n')}\n`,
  );
  return `${current ? 'updated' : 'created'} .gitignore (${missing.join(', ')})`;
}

/** How the project runs its tests, when it says so in a way heaw recognizes. */
async function testCommand(dir: string): Promise<string | undefined> {
  const packageFile = join(dir, 'package.json');
  if (existsSync(packageFile)) {
    try {
      const { scripts } = JSON.parse(await readFile(packageFile, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      // npm init's placeholder only fails.
      const test = scripts?.test;
      return test && !test.includes('no test specified') ? 'npm test' : undefined;
    } catch {
      return undefined;
    }
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(dir, 'go.mod'))) return 'go test ./...';
  return undefined;
}

const COMMENTED_VERIFICATION = `  // Without a hook, heaw sends the agent back once when it changed files and ran nothing since.
  // Checks the agent must pass before it may finish a run that changed files, e.g. the tests:
  // hooks: {
  //   async beforeStop({ workspace, editedFiles }) {
  //     if (!editedFiles.length) return;
  //     const tests = await workspace.exec('npm test', { timeoutMs: 600_000 });
  //     if (tests.exitCode !== 0) return { continue: true, feedback: tests.output.slice(-4_000) };
  //   },
  // },`;

function verificationTemplate(tests: string): string {
  return [
    '  hooks: {',
    '    // The agent may only finish a run that changed files once the tests pass.',
    '    async beforeStop({ workspace, editedFiles }) {',
    '      if (!editedFiles.length) return;',
    `      const tests = await workspace.exec('${tests}', { timeoutMs: 600_000 });`,
    '      if (tests.exitCode !== 0) {',
    '        return { continue: true, feedback: `The tests fail:\\n${tests.output.slice(-4_000)}` };',
    '      }',
    '      // To also have the reviewer (.heaw/agents/reviewer.md) look at the change, take',
    '      // runAgent from the hook context too:',
    "      // const review = await runAgent?.('reviewer', `Review the changes to ${editedFiles.join(', ')}.`);",
    '    },',
    '  },',
  ].join('\n');
}

function configTemplate(model: string, tests: string | undefined): string {
  return `import { defineConfig } from 'harness-engineered-agentic-workflow';

// heaw settings for this project. Credentials never go here: put them in .env and refer to them
// with env('NAME') (import { defineConfig, env } from the same package).
// For type checking in your editor: npm i -D harness-engineered-agentic-workflow
export default defineConfig({
  // provider:model. For Azure, the model part is your deployment name.
  model: '${model}',

  permissions: {
    // default: asks before edits and commands · accept-edits · read-only · bypass
    mode: 'default',
    // Calls that never need approval, e.g. 'run_command(npm test*)':
    allow: [${tests ? `'run_command(${tests}*)'` : ''}],
    // Calls that are never allowed:
    deny: ['read_file(**/.env*)'],
  },

  // providers: {
  //   azure: { endpoint: env('AZURE_OPENAI_ENDPOINT'), apiKey: env('AZURE_OPENAI_API_KEY') },
  //   lmstudio: { type: 'openai-compatible', baseURL: 'http://localhost:1234/v1' },
  // },
  // models: { 'azure:my-deployment': { contextWindow: 400_000 } },

  // Run commands in a Docker container instead of on this machine (needs Docker):
  // workspace: { type: 'docker', image: 'node:24', network: 'none' },

  // Per message: turns, tokens, cost (USD, needs the model's price) and minutes.
  // limits: { maxTurns: 100, maxCostUsd: 5, maxMinutes: 30 },

${tests ? verificationTemplate(tests) : COMMENTED_VERIFICATION}

  // MCP servers usually go in .mcp.json (heaw mcp add / heaw mcp install). APIs for http_request,
  // with credentials the model never sees:
  // http: {
  //   apis: { 'https://api.example.com/v1': { headers: { Authorization: env('EXAMPLE_TOKEN') } } },
  // },
});
`;
}

const AGENTS_TEMPLATE = `# AGENTS.md

<!--
Instructions for AI agents working in this project. heaw reads this file, and so do other agents
that follow the AGENTS.md convention. Comments like this one are not sent to the model, so an
unedited template costs nothing.
-->

## Project

<!-- What this project is and who uses it, in a few sentences. -->

## Commands

<!-- How to install, build, test and lint, e.g.
- Install: npm install
- Test: npm test
-->

## Conventions

<!-- Code style, structure, naming, libraries to use or avoid, how to write commit messages. -->
`;

const ENV_TEMPLATE = `# Credentials for heaw. Copy this file to .env (git ignores it) and fill in your provider.

# Azure OpenAI (Microsoft Foundry): key and endpoint from the resource's "Keys and Endpoint" page.
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=

# Other providers
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GOOGLE_GENERATIVE_AI_API_KEY=
`;

const REVIEWER_TEMPLATE = `---
name: reviewer
description: Reviews code or a change for bugs, risky edits and missing tests, without changing anything. Give it the files or the diff to look at.
tools: [read_file, list_dir, glob, grep]
mode: read-only
maxTurns: 30
---
You are a careful code reviewer. Read the code you are pointed to, and whatever it depends on,
before you judge it.

Report, most important first:
- bugs and wrong behaviour, with file:line and why it is wrong
- risky changes: security, data loss, breaking changes for callers
- missing or weak tests for what changed

Be concrete and brief. Say so when something looks fine; do not invent problems.
`;
