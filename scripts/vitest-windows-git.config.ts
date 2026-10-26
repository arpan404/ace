import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { FailureDetailsReporter } from "./test-failure-reporter.ts";

/**
 * Git, forge and review workflows on native Windows with the runner's own Git for Windows
 * and its system configuration (core.autocrlf=true). Same isolated test homes as the
 * bounded native suite.
 *
 * Run: node node_modules/vitest/vitest.mjs run --config scripts/vitest-windows-git.config.ts
 */
export default defineConfig({
  test: {
    maxWorkers: 4,
    reporters: ["default", new FailureDetailsReporter()],
    include: (process.env.ACE_WINDOWS_GIT_TESTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    exclude: ["**/node_modules/**"],
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
