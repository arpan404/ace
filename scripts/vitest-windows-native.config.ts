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
  // POSIX mode bits and a chmod-refused folder; "Windows update apply puts the original back
  // when the lock can't be written" runs instead.
  "when the lock can't be written the original folder is put back and the lock is unchanged",
  "the skills lock makes ~/.agents itself when it's missing",
  // Plugins. Windows has no FIFOs.
  "warmed source refuses a FIFO even when a writer supplies the original accepted bytes",
  // Executable bits; "on Windows accepted trust survives reopening", "on Windows staged or
  // accepted content tampering..." and "on Windows the package hash changes..." run instead.
  "reviews and accepted trust survive reopening and executable bits survive Git extraction",
  "staged tampering and accepted content or mode tampering cannot acquire or retain trust",
  "package hash includes paths and executable permissions",
  // Shebang fake Git and `ps`; the "on Windows ..." counterparts run a Node stand-in through the
  // real Windows Git spawn and check the helper pid is gone.
  "a detached Git helper terminates after timeout while holding stderr in .",
  "a detached Git helper terminates after normal exit while holding stderr in .",
  "a detached Git helper terminates after timeout while holding stderr in private/nested",
  "a detached Git helper terminates after normal exit while holding stderr in private/nested",
  "a detached Git helper terminates after timeout while holding stdout in .",
  "a detached Git helper terminates after normal exit while holding stdout in .",
  "a detached Git helper terminates after timeout while holding stdout in private/nested",
  "a detached Git helper terminates after normal exit while holding stdout in private/nested",
  "successful Git preparation terminates closed-pipe detached helpers in .",
  "successful Git preparation terminates closed-pipe detached helpers in private/nested",
  "Git overflow terminates descendants that retain stderr before completing",
  "Git timeout terminates descendants that retain stderr before completing",
  "Git exit terminates descendants that retain stderr before completing",
  "timeout cleanup rejection remains an observed operation failure",
  // Expects "/" after the plugin root and exec bits; "on Windows claude receives the plugin MCP
  // server..." and "on Windows Claude commands name plugin files..." run instead.
  "Claude receives native commands, agents, hook matchers, skill resources and MCP config",
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
  // Expect LF bytes in landed tracked files; Windows lands them as the person's own Git writes
  // them (core.autocrlf). "on Windows, a repository sent whole lands..." and "on Windows, opens
  // a project there..." check the same transfers against that.
  "sends the whole repository when the target can't clone its origin",
  "opens a project on another machine on the same branch, uncommitted changes still uncommitted there",
  // Makes links in the copy; ace never asks for the privilege Windows links need, so a folder
  // holding links can't land there yet (@ace/files has to leave them behind instead).
  "copies a folder that isn't a repository, keeping links inside it and dropping one that escapes",
  // POSIX mode bits (0600, 0755); "on Windows, brings .env and ignored local config..." checks
  // the same transfer without them.
  "brings .env and ignored local config with their modes, but not node_modules",
];

export default defineConfig({
  test: {
    maxWorkers: 2,
    reporters: ["default", new FailureDetailsReporter()],
    include: [
      "apps/daemon/src/transfers/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "packages/mcp-server/src/discovery-fifo.process.test.ts",
      // Windows has no FIFOs.
      "packages/plugins/src/source-fifo.process.test.ts",
    ],
    // Shared files also hold POSIX cases; each listed one has a Windows counterpart or no
    // Windows meaning. Names are matched whole.
    testNamePattern: new RegExp(`^(?!(?:${posixOnly.map(escapeName).join("|")})$)`),
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    globalSetup: ["./scripts/test-home-global-setup.ts", "./scripts/git-template-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
