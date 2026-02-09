import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      enabled: false, // Enable via CLI: --coverage
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', '**/node_modules/**', '**/dist/**'],
      thresholds: {
        // Start with achievable baseline, increase over time
        lines: 3,
        functions: 3,
        branches: 20,
        statements: 3,
      },
    },
  },
});
