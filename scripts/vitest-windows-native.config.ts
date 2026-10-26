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
      // Project listing, reads, Node search, watching and Git ignore rules. Windows searches
      // with ace's in-process Node backend, never ripgrep.
      "packages/workspace/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "packages/mcp-server/src/discovery-fifo.process.test.ts",
      // These write native paths into Git config text, which Git reads as bad escapes on
      // Windows; config-paths.process.test.ts runs the same cases with "/" paths.
      "packages/workspace/src/include-watch.process.test.ts",
      "packages/workspace/src/branch-includes.process.test.ts",
      "packages/workspace/src/head-reconciliation.process.test.ts",
    ],
    // Shared files also hold POSIX cases. This one checks POSIX owner uid and mode bits; its
    // Windows counterpart ("Windows bounded reads refuse junctions...") runs instead.
    //
    // Workspace cases left out, each with a Windows counterpart or no Windows meaning:
    // ripgrep-only cases (Windows always searches with Node); names holding "\\" or a newline,
    // which Windows can't create; "/dev/null" as a root; the forced Linux per-directory
    // watch strategy, which Windows never uses (it watches the root recursively); and the
    // symlink swap race, whose child can't rename a folder ace holds open on Windows
    // (junction-race.process.test.ts is the Windows case). The ignore-process count runs in
    // recursive-watch.process.test.ts with held timers: slow Windows runners start a native
    // scan of their own before the count.
    testNamePattern:
      /^(?!bounded regular-file reads refuse links, directories and oversized files$|keeps credentials in private session storage outside the workspace and removes them on release$)(?!.*(?:with backend rg|cancels after ripgrep begins matching and reaps it before rejecting|ripgrep and Node return identical literal, regex, case and glob results|uses the injected real process boundary for ripgrep selection and search|returns typed missing-file and wrong-kind errors|uses batched git ignore rules including nested negations and newline filenames|omits unsupported discovered filenames without corrupting listing or watch paths|never places a watch inside ignored or Git directories|never returns outside bytes while a real child swaps a parent directory for a symlink|one ignore process reconciles nested visible files while pruning ignored directories)$)/,
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
