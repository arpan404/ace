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
  // The data home's owner-only ACL protects the push secrets file on Windows.
  "stored push subscription secrets are accessible only to the local file owner",
  // Orders two same-expiry links by random id, so it fails half the time on every OS.
  "open pairing links are listed without their codes, and a cancelled one no longer pairs",
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
  // POSIX mode bits and a chmod-refused folder; "Windows update apply puts the original back
  // when the lock can't be written" runs instead.
  "when the lock can't be written the original folder is put back and the lock is unchanged",
  "the skills lock makes ~/.agents itself when it's missing",
  // chmod-refused skill folders and lock folder; the "Windows a restore blocked by an open
  // file...", "Windows a skills lock that can't be opened..." and "Windows a skill folder that
  // can't be opened..." counterparts make the same steps fail the Windows way.
  "a restore that fails keeps the current folder and the backup, and the next start finishes",
  "a skills lock that can't be opened is logged with its cause and recovery retries",
  "a skill folder that can't be opened keeps its journal, and a later start finishes",
  // Untyped relative symlinks and readlink text; Windows links are junctions with absolute
  // targets, and the protocol never carries link text. "Windows skill library creates a skill
  // and links it for Claude through a junction" and "Windows a junction-linked skill is listed
  // once..." run instead.
  "a linked skill is listed once, with each agent's access and a copy kept separate",
  "creating a skill saves it in the shared folder and links it for Claude",
  "without a race, agents are linked and unlinked in Claude's folder",
  // POSIX removes the link inside the moved folder; Windows can't read a link once its folder
  // moved and refuses with a conflict ("Windows removing an agent raced by a link-root swap...").
  "removing an agent raced by a link-root swap removes nothing outside the root",
  // A Unix socket; "Windows removes a cached command when its file becomes a junction" runs.
  "removes a cached snippet when its file becomes a nonregular filesystem entry",
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
  // Makes links in the copy; ace never asks for the privilege Windows links need. "on Windows,
  // copies a folder that isn't a repository, leaving its links behind" runs instead.
  "copies a folder that isn't a repository, keeping links inside it and dropping one that escapes",
  // POSIX mode bits (0600, 0755); "on Windows, brings .env and ignored local config..." checks
  // the same transfer without them.
  "brings .env and ignored local config with their modes, but not node_modules",
];

/**
 * Workspace cases matched by how the full name ends (some sit inside describe blocks), each with
 * a Windows counterpart or no Windows meaning: ripgrep-only cases (Windows always searches with
 * Node); names holding "\\" or a newline, which Windows can't create; "/dev/null" as a root;
 * the forced Linux per-directory watch strategy, which Windows never uses (it watches the root
 * recursively); and the symlink swap race, whose child can't rename a folder ace holds open on
 * Windows (junction-race.process.test.ts is the Windows case). The ignore-process count runs in
 * recursive-watch.process.test.ts with held timers: slow Windows runners start a native scan of
 * their own before the count.
 */
const posixOnlyEndings = [
  // Asserts key.pem's mode 0600; "on Windows, a LAN daemon makes its TLS identity itself..."
  // covers the same restart.
  "persists device credentials and the private TLS identity across daemon restarts in LAN mode",
  // Expects device scale 2, which GPU-less Windows runners don't draw at (`gpu-scale.ts`); its
  // "Windows: ... at the scale ace's Chrome draws" case runs.
  "a Retina viewer on this machine sees a still page, after a scroll too, as sharp as the page",
  "with backend rg",
  "cancels after ripgrep begins matching and reaps it before rejecting",
  "ripgrep and Node return identical literal, regex, case and glob results",
  "uses the injected real process boundary for ripgrep selection and search",
  "returns typed missing-file and wrong-kind errors",
  "uses batched git ignore rules including nested negations and newline filenames",
  "omits unsupported discovered filenames without corrupting listing or watch paths",
  "never places a watch inside ignored or Git directories",
  "never returns outside bytes while a real child swaps a parent directory for a symlink",
  "one ignore process reconciles nested visible files while pruning ignored directories",
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
      // Daemon lifecycle from the real `ace` CLI: stop, lock refusal, crash restart, Ctrl+Break,
      // and startup recovery of escaped provider trees and skill leases.
      "apps/daemon/src/daemon-stop-restart.process.test.ts",
      "apps/daemon/src/daemon-crash-recovery.process.test.ts",
      "apps/daemon/src/engine/restart-unverified.process.test.ts",
      "packages/git/src/disabled-hooks.process.test.ts",
      // Git and forge workflows against the runner's Git for Windows and gh: confined startup
      // in a held folder, long-path and CRLF worktrees/checkpoints, pull request hooks, and
      // command lookup that never runs a git.exe or gh.exe planted in a checkout.
      "packages/git/src/held-directory.process.test.ts",
      "packages/git/src/checkout-paths.process.test.ts",
      "packages/git/src/checkpoint-bytes.process.test.ts",
      "packages/git/src/reviewer-hooks.process.test.ts",
      // A timed-out Git call ends with its whole job and unlocks its repository; a stopped
      // daemon's lease ignores Git elsewhere, Git started later and the fsmonitor daemon.
      "packages/git/src/timeout-cleanup.process.test.ts",
      "packages/forge/src/command-search.process.test.ts",
      "packages/forge/src/command.process.test.ts",
      "packages/files/src/upload-identity.process.test.ts",
      "packages/workspace/src/path-policy.test.ts",
      "packages/terminal/src/shell.test.ts",
      "packages/terminal/src/pty.test.ts",
      "packages/provider-kit/src/process-containment.test.ts",
      "packages/provider-kit/src/process-identity.test.ts",
      "packages/provider-kit/src/process-tree-state.test.ts",
      "packages/provider-kit/src/process-owner.test.ts",
      "packages/provider-kit/src/process-owner.process.test.ts",
      "packages/provider-kit/src/process-inventory.restart.process.test.ts",
      "packages/provider-kit/src/process-interactive.native.process.test.ts",
      "tools/release/src/pty-assets.test.ts",
      "tools/release/src/node-runtime.test.ts",
      "tools/release/src/archive-paths.process.test.ts",
      // Cursor SDK staging: x64 ships its rg.exe helper, ARM64 ships no helper.
      "tools/release/src/cursor-runtime-assets.process.test.ts",
      "packages/adapter-cursor/src/ripgrep-path.test.ts",
      // Standalone daemon: the per-user login task, ace.cmd, pointer files and updates.
      "packages/service/src/task.process.test.ts",
      "tools/release/src/task-supervisor.test.ts",
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
      // Command discovery, prompt files and the skills library over Windows handles: junction
      // links, no-replace renames and crash recovery without an atomic exchange.
      "packages/commands/src/**/*.test.ts",
      // Uploads, downloads, edits, trash, folder archives and blob export.
      "packages/files/src/**/*.test.ts",
      // Project listing, reads, Node search, watching and Git ignore rules. Windows searches
      // with ace's in-process Node backend, never ripgrep.
      "packages/workspace/src/**/*.test.ts",
      // Providers: discovery and registry
      "packages/provider-kit/src/discovery/install-locations.process.test.ts",
      "packages/agent-registry/src/native-entrypoints.process.test.ts",
      // Providers: Cursor
      "packages/adapter-cursor/src/sdk-admission.process.test.ts",
      "packages/adapter-cursor/src/host-stop.process.test.ts",
      "packages/accounts/src/usage-sources/cursor-login.test.ts",
      // Providers: accounts, usage, history
      "packages/accounts/src/profile-accounts.process.test.ts",
      "packages/accounts/src/usage-sources/profile-read.test.ts",
      "packages/accounts/src/usage-sources/read.test.ts",
      "packages/provider-kit/src/discovery/pi-profile.process.test.ts",
      "packages/history-import/src/profile-history.process.test.ts",
      // Providers: Claude and Codex sessions
      "packages/adapter-codex/src/cmd-shim-session.process.test.ts",
      "packages/adapter-claude/src/cmd-shim-session.process.test.ts",
      "packages/adapter-claude/src/cmd-shim-metadata.process.test.ts",
      "packages/adapter-claude/src/fork.process.test.ts",
      // Providers: OpenCode, ACP and Pi sessions
      "packages/adapter-opencode/src/shim-launch.process.test.ts",
      "packages/adapter-acp/src/shim-session.process.test.ts",
      "packages/adapter-pi/src/shim-session.process.test.ts",
      // Providers: no descendant outlives a stop, even without a job
      "packages/provider-kit/src/tree-stop.process.test.ts",
      // Remote access, Fleet, automations, devices and doctor on Windows: Tailscale from PATH or
      // its install folder (a fake tailscale.exe), the OpenSSL-free TLS identity, pairing and
      // revocation, cross-machine delegation, schedules across sleep/restart, notifications,
      // Android SDK discovery, iOS-needs-a-Mac reporting, doctor and triage with ace stopped.
      "apps/daemon/src/tailscale-install.process.test.ts",
      "apps/daemon/src/lan-address.test.ts",
      "apps/daemon/src/tls-identity-node.process.test.ts",
      "apps/daemon/src/triage-handoff.process.test.ts",
      "apps/daemon/src/doctor/host-checks.test.ts",
      "apps/daemon/src/doctor/remote-access.test.ts",
      "apps/daemon/src/pairing-codes.process.test.ts",
      "apps/daemon/src/remote.server.process.test.ts",
      "apps/daemon/src/remote-restart.server.process.test.ts",
      "apps/daemon/src/fleet-access.server.process.test.ts",
      "apps/daemon/src/tailscale-https.server.process.test.ts",
      "apps/daemon/src/machines/fleet-links.test.ts",
      "apps/daemon/src/machines/child-recheck.test.ts",
      "apps/daemon/src/machines/machines.process.test.ts",
      "apps/daemon/src/machines/machine-queue-restart.process.test.ts",
      "apps/daemon/src/machines/children-reach.process.test.ts",
      "apps/daemon/src/automation-durability.process.test.ts",
      "packages/automations/src/service.test.ts",
      "packages/automations/src/durability.test.ts",
      "packages/automations/src/cancellation.test.ts",
      "packages/automations/src/startup.test.ts",
      "packages/automations/src/queue.test.ts",
      "packages/automations/src/audit-reliability.test.ts",
      "packages/offshift/src/journal.process.test.ts",
      "packages/offshift/src/steps.test.ts",
      "packages/offshift/src/next.test.ts",
      "packages/notify/src/delivery.test.ts",
      "packages/notify/src/log-holes.test.ts",
      "packages/notify/src/inbox.test.ts",
      "packages/notify/src/worker.process.test.ts",
      "packages/notify/src/webpush.process.test.ts",
      "packages/secure-channel/src/noise.test.ts",
      "packages/secure-channel/src/host-keys.process.test.ts",
      "packages/secure-channel/src/handshake-boundary.test.ts",
      "packages/devices/src/android-sdk-install.process.test.ts",
      "packages/devices/src/emulator-discovery.process.test.ts",
      // Desktop install, PATH and managed-daemon target on Windows.
      "apps/desktop/src/packaging/setup.test.ts",
      "apps/desktop/src/packaging/user-path.test.ts",
      "apps/desktop/src/main/os/cli-path.test.ts",
      "apps/desktop/src/main/daemon/target.test.ts",
      "apps/desktop/src/main/os/cli-shim.process.test.ts",
      "tools/release/src/bundle-addon.process.test.ts",
      "apps/desktop/src/packaging/authenticode.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "packages/mcp-server/src/discovery-fifo.process.test.ts",
      // Windows has no FIFOs.
      "packages/plugins/src/source-fifo.process.test.ts",
      // These write native paths into Git config text, which Git reads as bad escapes on
      // Windows; config-paths.process.test.ts runs the same cases with "/" paths.
      "packages/workspace/src/include-watch.process.test.ts",
      "packages/workspace/src/branch-includes.process.test.ts",
      "packages/workspace/src/head-reconciliation.process.test.ts",
    ],
    // Shared files also hold POSIX cases; each listed one has a Windows counterpart or no
    // Windows meaning. Names are matched whole.
    testNamePattern: new RegExp(
      `^(?!(?:${posixOnly.map(escapeName).join("|")})$)(?!.*(?:${posixOnlyEndings.map(escapeName).join("|")})$)`,
    ),
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    // process-test-setup builds the daemon CLI and the shared TLS fixture the remote, Fleet and
    // automation suites start daemons with.
    globalSetup: ["./scripts/test-home-global-setup.ts", "./scripts/process-test-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
