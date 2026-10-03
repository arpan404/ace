import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

export default defineConfig({
  test: {
    // Bound runner overhead too: all CPU cores are usually shared with other agents.
    maxWorkers: 2,
    fsModuleCache: true,
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "tools/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
          ],
          exclude: ["**/*.process.test.ts"],
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "process",
          include: ["{packages,tools,apps}/*/src/**/*.process.test.ts"],
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          globalSetup: ["./scripts/process-test-setup.ts"],
        },
      },
    ],
  },
});
