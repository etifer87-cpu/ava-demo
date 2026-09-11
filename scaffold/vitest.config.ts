import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * The tests are written against `describe / it / expect` as globals (tsconfig.json declares
 * vitest/globals); the runtime has to be told the same thing, or every suite fails on its first
 * line. Kit defect 17: the kit shipped the types without this file.
 */
export default defineConfig({
  test: { globals: true, include: ['lib/**/*.test.ts', 'scripts/**/*.test.mjs'] },
  resolve: { alias: { '@': path.resolve(__dirname) } },
});
