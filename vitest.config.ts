import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@vca/shared': path.resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
  '@vca/api': path.resolve(import.meta.dirname, 'apps/api/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'security', include: ['tests/security/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 } },
      { resolve: { alias }, test: { name: 'property', include: ['tests/property/**/*.test.ts'], testTimeout: 300_000 } },
      { resolve: { alias }, test: { name: 'architecture', include: ['tests/architecture/**/*.test.ts'] } },
    ],
  },
});
