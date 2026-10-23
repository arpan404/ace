import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { FailureDetailsReporter } from "./test-failure-reporter.ts";

/**
 * Bounded Windows-native foundation suite (first native-verification cut).
 *
 * Scope: Windows handle-core read fixtures, stat/metadata fixtures, real
 * SID / Windows-job / ConPTY fixtures, plus pure Windows units (shell
 * selection, path policy, batch command, job/identity contracts, ConPTY gate
 * units, Windows process supervision). No root POSIX process suite, no
 * recorder, no provider CLIs.
 *
 * Isolation: reuses the repo's test-home global setup and per-file setup so
 * the enclosing-repository guard stays enforced. Nothing here weakens or
 * disables that guard.
 *
 * Fail-closed: Windows-only process tests require dist/windows-core.node
 * (built natively in CI before this config runs). Off Windows they report
 * skipped, never red; a missing native binary on Windows fails, never skips.
 *
 * Run: node node_modules/vitest/vitest.mjs run --config scripts/vitest-windows-native.config.ts
 * Never: bun test (Bun's own runner).
 */
export default defineConfig({
  test: {
    maxWorkers: 2,
    reporters: ["default", new FailureDetailsReporter()],
    include: [
      "packages/workspace/src/windows-core.process.test.ts",
      "packages/workspace/src/windows-metadata.process.test.ts",
      "packages/workspace/src/windows-write.process.test.ts",
      "packages/workspace/src/windows-rename.process.test.ts",
      "packages/workspace/src/windows-private.process.test.ts",
      "packages/workspace/src/windows-private-create.process.test.ts",
      "packages/workspace/src/command-stdin.process.test.ts",
      "packages/workspace/src/rg-stdin.process.test.ts",
      "packages/provider-kit/src/windows-job.process.test.ts",
      "packages/provider-kit/src/windows-process-identity.process.test.ts",
      "packages/terminal/src/win32.process.test.ts",
      "packages/workspace/src/path-policy.test.ts",
      "packages/terminal/src/shell.test.ts",
      "packages/terminal/src/win32.test.ts",
      "packages/provider-kit/src/windows-job.test.ts",
      "packages/provider-kit/src/windows-process-identity.test.ts",
      "packages/provider-kit/src/windows-command.test.ts",
      "packages/provider-kit/src/process-windows-native.process.test.ts",
      "tools/release/src/pty-assets.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
