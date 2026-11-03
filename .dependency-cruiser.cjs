// Architecture rules from docs/DESIGN.md §3. Run with `npm run lint:deps`.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make modules impossible to reason about in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-stays-independent',
      severity: 'error',
      comment:
        'core depends only on its own interfaces. Providers, tools, MCP, workspaces, config, ' +
        'observability, evals and the CLI plug into core, never the other way round.',
      from: { path: '^src/core/' },
      to: { path: '^src/(?!core/)' },
    },
    {
      name: 'only-cli-imports-cli',
      severity: 'error',
      comment: 'The CLI is one consumer of the engine. Nothing else may depend on it.',
      from: { path: '^src/(?!cli/)' },
      to: { path: '^src/cli/' },
    },
    {
      name: 'no-dev-deps-in-src',
      severity: 'error',
      comment: 'Shipped code must not import devDependencies; they are not installed for users.',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
