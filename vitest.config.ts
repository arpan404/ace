import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contain hung tests without using shared-host scheduling as a performance assertion.
    testTimeout: 60_000,
    include: ["packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
