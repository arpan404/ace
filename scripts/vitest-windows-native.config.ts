import { defineConfig } from "vitest/config";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { FailureDetailsReporter } from "./test-failure-reporter.ts";

/**
 * Bounded Windows-native foundation suite (first native-verification cut).
 *
 * Scope: the shared project-folder safety tests (pinned directory and
 * confinement), the daemon data-directory lock, real Windows-job /
 * ConPTY fixtures, plus pure Windows units (shell selection, path policy,
 * batch command, job/identity contracts, ConPTY backend units, Windows
 * process supervision). No root POSIX process suite, no
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
      "packages/browser/src/discovery.test.ts",
      "packages/browser/src/chrome-video.test.ts",
      "packages/browser-extension/src/install.process.test.ts",
      "packages/preview/src/discovery.process.test.ts",
      "packages/provider-kit/src/process-containment.process.test.ts",
      "packages/provider-kit/src/process-identity.process.test.ts",
      "packages/terminal/src/pty.process.test.ts",
      "packages/browser/src/video-sharpness.process.test.ts",
      "packages/workspace/src/pinned-directory.process.test.ts",
      "packages/workspace/src/confinement.process.test.ts",
      "apps/daemon/src/local-files.test.ts",
      "packages/git/src/disabled-hooks.process.test.ts",
      "packages/files/src/upload-identity.process.test.ts",
      "packages/workspace/src/path-policy.test.ts",
      "packages/terminal/src/shell.test.ts",
      "packages/terminal/src/pty.test.ts",
      "packages/provider-kit/src/process-containment.test.ts",
      "packages/provider-kit/src/process-identity.test.ts",
      "packages/provider-kit/src/process-owner.test.ts",
      "packages/provider-kit/src/process-owner.process.test.ts",
      "packages/provider-kit/src/process-inventory.restart.process.test.ts",
      "packages/provider-kit/src/process-interactive.native.process.test.ts",
      "tools/release/src/pty-assets.test.ts",
      "tools/release/src/node-runtime.test.ts",
      "tools/release/src/archive-paths.process.test.ts",
      // Screen helper lifecycle over the protocol-v2 fake on a named pipe: negotiation,
      // fragmented frames, crash/restart ownership, pending-read takeover, suspend/resume,
      // oversized commands and retired packets.
      "packages/screen/src/windows.process.test.ts",
      "packages/screen/src/lifecycle-review.process.test.ts",
      "packages/screen/src/ui-results.process.test.ts",
      // ace's MCP server: loopback HTTP with bearer leases, the ACP stdio bridge, list_changed,
      // provider config discovery and private session config. FIFO and /dev/null fixtures are
      // POSIX-only and stay out.
      "packages/mcp-server/src/**/*.test.ts",
      // Sandboxed HTML visualizations and handoff documents.
      "packages/html/src/**/*.test.ts",
      "packages/handoff/src/**/*.test.ts",
      // Command discovery, prompt files and the skills library over Windows handles: junction
      // links, no-replace renames and crash recovery without an atomic exchange.
      "packages/commands/src/command-junctions.process.test.ts",
      "packages/commands/src/skill-junctions.process.test.ts",
      "packages/commands/src/skill-update-swap.process.test.ts",
      "packages/commands/src/files.process.test.ts",
      "packages/commands/src/prompt-files.process.test.ts",
      "packages/commands/src/skill-updates.process.test.ts",
    ],
    exclude: ["**/node_modules/**", "packages/mcp-server/src/discovery-fifo.process.test.ts"],
    // Shared files also hold POSIX cases. This one checks POSIX owner uid and mode bits; its
    // Windows counterpart ("Windows bounded reads refuse junctions...") runs instead.
    // The skills-lock cases check POSIX mode bits and a chmod-refused folder; "Windows update
    // apply puts the original back when the lock can't be written" runs instead.
    testNamePattern:
      /^(?!bounded regular-file reads refuse links, directories and oversized files$|keeps credentials in private session storage outside the workspace and removes them on release$|when the lock can't be written the original folder is put back and the lock is unchanged$|the skills lock makes ~\/\.agents itself when it's missing$)/,
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
