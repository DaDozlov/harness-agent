import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  fixedExtension: false,
  dts: true,
  clean: true,
});
