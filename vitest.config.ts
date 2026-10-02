import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Git, SQLite and process fixtures need bounded concurrency on shared runners.
    maxWorkers: 4,
    // Deadlock guard for real-edge fixtures; performance is measured only in bench/.
    testTimeout: 30_000,
    include: ["packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
