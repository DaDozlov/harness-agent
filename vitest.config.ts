import { defineConfig } from 'vitest/config';

const DOCKER_TESTS = 'test/workspace/docker.test.ts';

export default defineConfig({
  test: {
    // Some tests load the config through the whole source tree or start npm and git; on a busy
    // machine (or a CI runner) that takes longer than the default 5 s.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/**/*.test.{ts,tsx}'], exclude: [DOCKER_TESTS] },
      },
      // Containers start slowly while the other test files keep the machine busy, so the Docker
      // tests run after them.
      {
        extends: true,
        test: { name: 'docker', include: [DOCKER_TESTS], sequence: { groupOrder: 1 } },
      },
    ],
  },
});
