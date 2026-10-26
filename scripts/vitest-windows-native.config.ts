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
const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** POSIX-only cases inside files that otherwise run on Windows. */
const posixOnly = [
  // POSIX owner uid and mode bits; "Windows bounded reads refuse junctions..." runs instead.
  "bounded regular-file reads refuse links, directories and oversized files",
  // Mode bits; the Windows private-config test checks the same refusals without them.
  "keeps credentials in private session storage outside the workspace and removes them on release",
  // Expected paths are built with "/"; "Windows mentions reach providers with native full
  // paths..." checks the native paths instead.
  "binary mentions include a readable full path",
  "an @-mentioned workspace image reaches each provider in its native image form",
  "an @-mentioned PDF reaches document-capable providers as a native document",
  // Matches a JSON-escaped path with an unescaped one; everything before that line passes.
  "all files survive restart, classify by bytes and reach native, inline or readable path input",
  // File names Windows can't hold (newline, leading colon, pathspec magic characters).
  "one batch keeps tracked ignored, re-included, symlinked and unusual names correct",
  "a file under an ignored folder whose name starts with a colon stays out of context",
  "a file named like pathspec magic reconciles without failing its batch",
  // Windows still registers the session screen tools beside the computer-use engine's; the
  // computer-use branch moves Windows to the engine, which brings this back under budget.
  "each provider's per-request ace context stays within its budget",
];

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
      // Plugins (install, review, projection, launch, Git fetch) and composer context
      // (mentions, uploads, attachments, watcher recovery).
      "packages/plugins/src/**/*.test.ts",
      "packages/context/src/**/*.test.ts",
      // The daemon's MCP sessions and tools, and project/thread transfers between machines.
      "apps/daemon/src/mcp*.test.ts",
      "apps/daemon/src/transfers/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "packages/mcp-server/src/discovery-fifo.process.test.ts"],
    // Shared files also hold POSIX cases; each listed one has a Windows counterpart or no
    // Windows meaning. Names are matched whole.
    testNamePattern: new RegExp(`^(?!(?:${posixOnly.map(escapeName).join("|")})$)`),
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
