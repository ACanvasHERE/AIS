import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    platform: 'node',
    clean: true,
    dts: true,
    sourcemap: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    clean: false,
    dts: true,
    sourcemap: false,
  },
]);
