import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
