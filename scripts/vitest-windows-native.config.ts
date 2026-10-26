import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { FailureDetailsReporter } from "./test-failure-reporter.ts";

/**
 * Bounded Windows-native foundation suite (first native-verification cut).
 *
 * Scope: the shared project-folder safety tests (pinned directory and
 * confinement), the daemon data-directory lock on SQLite, real Windows-job /
 * ConPTY fixtures, plus pure Windows units (shell
 * selection, path policy, batch command, job/identity contracts, ConPTY gate
 * units, Windows process supervision). No root POSIX process suite, no
 * recorder, no provider CLIs.
 *
 * Isolation: reuses the repo's test-home global setup and per-file setup so
 * the enclosing-repository guard stays enforced. Nothing here weakens or
 * disables that guard.
 *
 * Fail-closed: workspace tests require dist/descriptor.node (built natively
 * by build.ts in CI before this config runs); a missing native binary on
 * Windows fails, never skips.
 *
 * Run: node node_modules/vitest/vitest.mjs run --config scripts/vitest-windows-native.config.ts
 * Never: bun test (Bun's own runner).
 */
export default defineConfig({
  test: {
    maxWorkers: 2,
    reporters: ["default", new FailureDetailsReporter()],
    include: [
      "packages/browser/src/video-software.process.test.ts",
      "packages/browser/src/discovery-windows.test.ts",
      "packages/browser/src/owned-chromium.test.ts",
      "packages/browser-extension/src/windows-install.process.test.ts",
      "packages/browser-extension/src/windows-registry.process.test.ts",
      "packages/browser/src/video-sharpness.process.test.ts",
      "packages/workspace/src/pinned-directory.process.test.ts",
      "packages/workspace/src/confinement.process.test.ts",
      "apps/daemon/src/local-files.test.ts",
      "packages/preview/src/discovery.process.test.ts",
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
      "tools/release/src/archive-paths.process.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
