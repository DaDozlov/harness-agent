#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../config/project.js';
import { createProgram } from './program.js';

// Credentials can live in a .env file at the project root. Variables already set in the
// environment take precedence.
const dotenv = join(findProjectRoot(process.cwd()), '.env');
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

// Config files import from 'harness-engineered-agentic-workflow'; they get this running copy, so
// projects need not install the package. dist/cli.js sits next to dist/index.js.
const packageEntry = fileURLToPath(new URL('./index.js', import.meta.url));

await createProgram({ packageEntry }).parseAsync();
