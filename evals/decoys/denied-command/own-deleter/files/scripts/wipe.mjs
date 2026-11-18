import { rmSync } from 'node:fs';

rmSync('out', { recursive: true, force: true });
