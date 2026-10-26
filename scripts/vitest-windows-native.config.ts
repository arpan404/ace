import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { FailureDetailsReporter } from "./test-failure-reporter.ts";

/**
 * Bounded Windows-native foundation suite (first native-verification cut).
 *
 * Scope: Windows handle-core read fixtures, stat/metadata fixtures, real
 * SID / job-object / ConPTY fixtures, plus pure Windows units (shell
 * selection, path policy, batch command, job/identity contracts, ConPTY
 * backend units, process-tree supervision). No root POSIX process suite, no
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
      "packages/browser/src/video-software.process.test.ts",
      "packages/browser/src/discovery-windows.test.ts",
      "packages/browser/src/owned-chromium.test.ts",
      "packages/browser-extension/src/windows-install.process.test.ts",
      "packages/browser-extension/src/windows-registry.process.test.ts",
      "packages/browser/src/video-sharpness.process.test.ts",
      "packages/workspace/src/windows-core.process.test.ts",
      "packages/workspace/src/windows-metadata.process.test.ts",
      "packages/workspace/src/windows-metadata-open.process.test.ts",
      "packages/workspace/src/windows-write.process.test.ts",
      "packages/workspace/src/windows-rename.process.test.ts",
      "packages/workspace/src/windows-private.process.test.ts",
      "packages/workspace/src/windows-private-create.process.test.ts",
      "packages/workspace/src/windows-private-metadata.process.test.ts",
      "packages/workspace/src/windows-private-directory.process.test.ts",
      "packages/workspace/src/windows-descriptor-stat.process.test.ts",
      "packages/workspace/src/windows-filesystem.process.test.ts",
      "packages/workspace/src/windows-workspace.process.test.ts",
      "apps/daemon/src/builtin-skill-private.windows.process.test.ts",
      "apps/daemon/src/windows-startup.process.test.ts",
      "apps/daemon/src/windows-local-files.process.test.ts",
      "packages/service/src/windows-home.process.test.ts",
      "packages/service/src/windows-pointer.process.test.ts",
      "packages/git/src/windows-guid-cwd.process.test.ts",
      "packages/preview/src/discovery.process.test.ts",
      "packages/plugins/src/windows-ownership.process.test.ts",
      "packages/workspace/src/command-stdin.process.test.ts",
      "packages/workspace/src/rg-stdin.process.test.ts",
      "packages/provider-kit/src/process-containment.process.test.ts",
      "packages/provider-kit/src/sqlite.process.test.ts",
      "packages/provider-kit/src/process-identity.process.test.ts",
      "packages/terminal/src/pty.process.test.ts",
      "packages/workspace/src/path-policy.test.ts",
      "packages/terminal/src/shell.test.ts",
      "packages/terminal/src/pty.test.ts",
      "packages/provider-kit/src/process-containment.test.ts",
      "packages/provider-kit/src/process-identity.test.ts",
      "packages/provider-kit/src/process-owner.test.ts",
      "packages/provider-kit/src/process-owner.process.test.ts",
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
