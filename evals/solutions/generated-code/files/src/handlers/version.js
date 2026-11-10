import { readFileSync } from 'node:fs';

const { version: current } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export function version() {
  return { status: 200, body: { version: current } };
}
