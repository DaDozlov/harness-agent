import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../src/core/tools.js';
import { mcpSearchTool } from '../../src/mcp/agent-tools.js';
import {
  describeSkipped,
  findRegistryServer,
  planInstall,
  type RegistryServer,
  searchRegistry,
  suggestName,
} from '../../src/mcp/registry.js';
import { callTool } from '../helpers.js';

/** Real entries from registry.modelcontextprotocol.io, recorded in November 2026. */
const RECORDED = JSON.parse(
  readFileSync(resolve('test/fixtures/registry-servers.json'), 'utf8'),
) as RegistryServer[];
const recorded = (name: string) => RECORDED.find((server) => server.name === name)!;

const server = (fields: Partial<RegistryServer>): RegistryServer => ({
  name: 'io.github.someone/sample-mcp',
  version: '1.0.0',
  ...fields,
});

/** A fetch that answers every request with `body`, recording the URLs asked for. */
function fakeFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = (input) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { urls, fetch };
}

describe('planning an install from the registry', () => {
  it('runs a Docker image and leaves out an optional token, named after the server', () => {
    const plan = planInstall(recorded('io.github.github/github-mcp-server'));

    expect(plan.via).toBe('Docker image ghcr.io/github/github-mcp-server:2.0.3');
    expect(plan.config).toEqual({
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-p',
        '127.0.0.1:8085:8085',
        '-e',
        'GITHUB_OAUTH_CALLBACK_PORT=8085',
        'ghcr.io/github/github-mcp-server:2.0.3',
      ],
    });
    expect(plan.variables).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        target: 'args-before-package',
        entry: '"-e", "GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_TOKEN}"',
        description: expect.stringContaining('Optional GitHub Personal Access Token') as unknown,
      },
    ]);
    expect(describeSkipped(plan.skipped[0]!)).toMatch(
      /^"-e", "GITHUB_PERSONAL_ACCESS_TOKEN=\$\{GITHUB_TOKEN\}" \(in "args", before the package\) — Optional/,
    );
  });

  it('names variables after the local name it is installed as', () => {
    const plan = planInstall(recorded('io.github.github/github-mcp-server'), { name: 'gh-work' });

    expect(plan.skipped[0]?.entry).toBe('"-e", "GITHUB_PERSONAL_ACCESS_TOKEN=${GH_WORK_TOKEN}"');
  });

  it('keeps a secret header of a remote server as a variable instead of asking for a login', () => {
    const plan = planInstall(recorded('io.github.github/github-mcp-server'), { remote: true });

    expect(plan.config).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: '${GITHUB_AUTHORIZATION}' },
    });
    expect(plan.variables).toEqual([
      {
        name: 'GITHUB_AUTHORIZATION',
        description: expect.stringContaining('Authorization header') as unknown,
        secret: true,
        required: true,
      },
    ]);
  });

  it('uses OAuth for a remote server without headers', () => {
    const plan = planInstall(recorded('com.atlassian/atlassian-mcp-server'));

    expect(plan).toEqual({
      config: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', oauth: true },
      variables: [],
      skipped: [],
      via: 'remote server https://mcp.atlassian.com/v2/mcp',
    });
  });

  it('passes declared environment variables by their own names and lists optional ones', () => {
    const plan = planInstall(recorded('com.pulsemcp/gcs'));

    expect(plan.config).toEqual({
      command: 'npx',
      args: ['-y', 'gcs-google-mcp-server@0.1.14'],
      env: {
        GCS_PROJECT_ID: '${GCS_PROJECT_ID}',
        SKIP_HEALTH_CHECKS: '${SKIP_HEALTH_CHECKS:-false}',
      },
    });
    expect(plan.variables).toEqual([
      {
        name: 'GCS_PROJECT_ID',
        description: 'Google Cloud project ID.',
        secret: false,
        required: true,
      },
      {
        name: 'SKIP_HEALTH_CHECKS',
        description: 'Skip health checks on startup.',
        secret: false,
        required: false,
        default: 'false',
      },
    ]);
    expect(plan.skipped.map((input) => [input.target, input.entry])).toContainEqual([
      'env',
      '"GCS_BUCKET": "${GCS_BUCKET}"',
    ]);
    expect(plan.skipped).toHaveLength(6);
  });

  it('prefers a PyPI package to a Docker image', () => {
    const plan = planInstall(recorded('com.mcparmory/atlassian-confluence'));

    expect(plan.config).toEqual({
      command: 'uvx',
      args: ['mcparmory-atlassian-confluence==1.0.8'],
    });
    expect(plan.via).toBe('pypi package mcparmory-atlassian-confluence==1.0.8');
  });

  it('handles flags, values from variables and fixed values in arguments and environment', () => {
    const plan = planInstall(
      server({
        packages: [
          {
            registryType: 'npm',
            identifier: '@someone/sample',
            version: '2.1.0',
            runtimeArguments: [{ type: 'positional', value: '-y' }],
            packageArguments: [
              { type: 'positional', valueHint: 'directory', isRequired: true },
              { type: 'named', name: '--verbose', isRequired: true },
              { type: 'named', name: '--read-only' },
              { type: 'named', name: '--mode', value: 'fs' },
              {
                type: 'named',
                name: '--api',
                value: 'https://{host}/v1',
                isRequired: true,
                variables: { host: { description: 'Host name', default: 'api.example.com' } },
              },
              {
                type: 'named',
                name: '--key',
                value: '{sample_key}',
                isRequired: true,
                variables: { sample_key: { isSecret: true } },
              },
            ],
            environmentVariables: [
              { name: 'LOG_FORMAT', value: 'json' },
              {
                name: 'API_TOKEN',
                value: 'Bearer {token}',
                isRequired: true,
                variables: { token: { isSecret: true } },
              },
            ],
          },
        ],
      }),
    );

    expect(plan.config).toEqual({
      command: 'npx',
      args: [
        '-y',
        '@someone/sample@2.1.0',
        '${SAMPLE_DIRECTORY}',
        '--verbose',
        '--mode',
        'fs',
        '--api',
        'https://${SAMPLE_HOST:-api.example.com}/v1',
        '--key',
        '${SAMPLE_KEY}',
      ],
      env: { LOG_FORMAT: 'json', API_TOKEN: 'Bearer ${SAMPLE_TOKEN}' },
    });
    expect(plan.variables.map((variable) => [variable.name, variable.required])).toEqual([
      ['SAMPLE_TOKEN', true],
      ['SAMPLE_DIRECTORY', true],
      ['SAMPLE_HOST', false],
      ['SAMPLE_KEY', true],
    ]);
    expect(plan.skipped).toEqual([
      { target: 'args-after-package', entry: '"--read-only"', description: undefined },
    ]);
  });

  it('gives a container optional variables as -e arguments', () => {
    const plan = planInstall(
      server({
        packages: [
          {
            registryType: 'oci',
            identifier: 'docker.io/someone/sample:1.0.0',
            environmentVariables: [
              { name: 'SAMPLE_TOKEN', isRequired: true, isSecret: true },
              { name: 'SAMPLE_REGION', description: 'Region' },
            ],
          },
        ],
      }),
    );

    expect(plan.config).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'SAMPLE_TOKEN', 'docker.io/someone/sample:1.0.0'],
      env: { SAMPLE_TOKEN: '${SAMPLE_TOKEN}' },
    });
    expect(plan.skipped).toEqual([
      {
        target: 'args-before-package',
        entry: '"-e", "SAMPLE_REGION=${SAMPLE_REGION}"',
        description: 'Region',
      },
    ]);
  });

  it('fills header placeholders, and leaves out optional headers that are not secret', () => {
    const plan = planInstall(
      server({
        remotes: [
          {
            type: 'sse',
            url: 'https://sample.dev/sse',
            headers: [
              {
                name: 'Authorization',
                value: 'Bearer {api_key}',
                isRequired: true,
                variables: { api_key: { isSecret: true } },
              },
              { name: 'X-Client', value: 'heaw' },
              { name: 'X-Workspace', description: 'Workspace id' },
            ],
          },
        ],
      }),
    );

    expect(plan.config).toEqual({
      type: 'sse',
      url: 'https://sample.dev/sse',
      headers: { Authorization: 'Bearer ${SAMPLE_API_KEY}', 'X-Client': 'heaw' },
    });
    expect(plan.skipped).toEqual([
      {
        target: 'headers',
        entry: '"X-Workspace": "${SAMPLE_X_WORKSPACE}"',
        description: 'Workspace id',
      },
    ]);
  });

  it('asks for a login when a remote server only has fixed headers', () => {
    const plan = planInstall(
      server({
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://sample.dev/mcp',
            headers: [{ name: 'X-Client', value: 'heaw' }],
          },
        ],
      }),
    );

    expect(plan.config).toMatchObject({ headers: { 'X-Client': 'heaw' }, oauth: true });
  });

  it('explains servers it cannot run', () => {
    const nuget = server({
      packages: [{ registryType: 'nuget', identifier: 'Sample.Server', version: '1.0.0' }],
    });

    expect(() => planInstall(nuget)).toThrow(
      'heaw cannot run "io.github.someone/sample-mcp" yet: it is published only as nuget.',
    );
  });

  it('suggests short local names', () => {
    expect(suggestName('io.github.github/github-mcp-server')).toBe('github');
    expect(suggestName('com.pulsemcp/gcs')).toBe('gcs');
    expect(suggestName('io.github.someone/mcp-server-postgres')).toBe('postgres');
    expect(suggestName('com.atlassian/atlassian-mcp-server')).toBe('atlassian');
    expect(suggestName('io.github.someone/Weird.Name')).toBe('weird-name');
  });
});

describe('searching the registry', () => {
  it('asks for the latest versions and returns the servers', async () => {
    const { urls, fetch } = fakeFetch({ servers: RECORDED.map((entry) => ({ server: entry })) });

    const servers = await searchRegistry('atlassian', { fetch, limit: 4 });

    expect(servers.map((entry) => entry.name)).toEqual(RECORDED.map((entry) => entry.name));
    expect(urls).toEqual([
      'https://registry.modelcontextprotocol.io/v0/servers?search=atlassian&version=latest&limit=4',
    ]);
  });

  it('finds a server by its exact name, ignoring case', async () => {
    const { fetch } = fakeFetch({ servers: RECORDED.map((entry) => ({ server: entry })) });

    expect((await findRegistryServer('COM.PULSEMCP/GCS', { fetch }))?.name).toBe(
      'com.pulsemcp/gcs',
    );
    expect(await findRegistryServer('com.pulsemcp', { fetch })).toBeUndefined();
  });

  it('reports registry errors', async () => {
    const { fetch } = fakeFetch({}, 503);

    await expect(searchRegistry('jira', { fetch })).rejects.toThrow(
      'The MCP Registry answered HTTP 503 for "jira".',
    );
  });

  it('gives the agent ready .mcp.json entries, variables and what was left out', async () => {
    const tool = mcpSearchTool(() => Promise.resolve(RECORDED));

    const { output } = await callTool(tool, { query: 'anything' }, {} as ToolContext);

    expect(output).toContain(
      '.mcp.json entry: "github": {"command":"docker","args":["run","-i","--rm",',
    );
    expect(output).toContain(
      '"-e", "GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_TOKEN}" (in "args", before the package)',
    );
    expect(output).toContain('needs: GCS_PROJECT_ID, SKIP_HEALTH_CHECKS (optional)');
    expect(output).toContain(
      '.mcp.json entry: "atlassian": {"type":"http","url":"https://mcp.atlassian.com/v2/mcp","oauth":true}',
    );
  });
});
