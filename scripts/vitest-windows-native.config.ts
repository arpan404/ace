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
/**
 * Exact names of shared-file tests that assert POSIX-only behaviour. Each has a "Windows: ..."
 * counterpart in the same file that proves the Windows behaviour instead.
 */
const posixOnly = [
  // POSIX owner uid and mode bits; "Windows bounded reads refuse junctions..." runs instead.
  "bounded regular-file reads refuse links, directories and oversized files",
  "keeps credentials in private session storage outside the workspace and removes them on release",
  // packages/files: Unix sockets, POSIX symlink creation on unpack and mode bits.
  "round-trips a folder with nested files, empty dirs, modes, binaries and inside links",
  "skips sockets and links that leave the folder, and counts them",
  "measures exactly the bytes and entries that packing writes",
  "preserves executable permissions when replacing a file through edits or uploads",
  // Matches the destination with a "/" separator.
  "directory deletion rechecks agent edits after a failed queued write",
  // Windows tar prints CRLF and decodes names through the ANSI code page.
  "streams a folder archive with bounded RSS and excludes ignored files and symlinks",
  "streams interoperable PAX archives with long UTF-8 names and complete files beyond 8 GiB",
  // Mode 0, 100, 200 and 400 files; Windows has only the read-only attribute.
  ...[false, true].flatMap((restart) =>
    ["0", "200", "100"].flatMap((mode) =>
      ["intent", "prepared"].map(
        (fault) =>
          `a mode ${mode} replacement resumes acknowledged bytes after interrupted ${fault}${restart ? " and restart" : " in the running service"}`,
      ),
    ),
  ),
  ...["file", "symlink", "hardlink"].map(
    (replacement) =>
      `unpublished permission recovery leaves a replacement ${replacement} untouched`,
  ),
  ...["200", "0", "100"].map(
    (mode) =>
      `a replacement publishes mode ${mode} before losing publication completion and recovers without read access`,
  ),
  ...["startup", "other uploads"].flatMap((blocked) =>
    ["moved", "replaced", "permissions"].map(
      (alteration) =>
        `a pending receipt with a ${alteration} destination settles without blocking ${blocked}`,
    ),
  ),
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
      // Uploads, downloads, edits, trash, folder archives and blob export.
      "packages/files/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "packages/mcp-server/src/discovery-fifo.process.test.ts"],
    // Shared files also hold POSIX cases. This one checks POSIX owner uid and mode bits; its
    // Windows counterpart ("Windows bounded reads refuse junctions...") runs instead.
    testNamePattern: new RegExp(
      `^(?!(?:${posixOnly.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$)`,
    ),
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
