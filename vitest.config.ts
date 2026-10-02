import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    include: ["packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
