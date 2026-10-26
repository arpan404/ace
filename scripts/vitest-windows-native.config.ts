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
      // Screen helper lifecycle over the protocol-v2 fake on a named pipe: negotiation,
      // fragmented frames, crash/restart ownership, pending-read takeover, suspend/resume,
      // oversized commands and retired packets.
      "packages/screen/src/windows.process.test.ts",
      "packages/screen/src/lifecycle-review.process.test.ts",
      "packages/screen/src/ui-results.process.test.ts",
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
    ],
    exclude: ["**/node_modules/**"],
    // Shared files also hold POSIX cases. These check POSIX owner uid and mode bits; Windows
    // counterparts ("Windows bounded reads refuse junctions...") run instead, and the data
    // home's owner-only ACL protects the push secrets file on Windows. The LAN restart case
    // asserts key.pem's mode 0600; "on Windows, a LAN daemon makes its TLS identity itself..."
    // covers the same restart. The pairing-list case orders two same-expiry links by random id,
    // so it fails half the time on every OS.
    testNamePattern:
      /^(?!(?:bounded regular-file reads refuse links, directories and oversized files|stored push subscription secrets are accessible only to the local file owner|(?:remote access(?: > | ))?persists device credentials and the private TLS identity across daemon restarts in LAN mode|open pairing links are listed without their codes, and a cancelled one no longer pairs)$)/,
    testTimeout: PROCESS_TEST_TIMEOUT,
    hookTimeout: PROCESS_TEST_TIMEOUT,
    // process-test-setup builds the daemon CLI and the shared TLS fixture the remote, Fleet and
    // automation suites start daemons with.
    globalSetup: ["./scripts/test-home-global-setup.ts", "./scripts/process-test-setup.ts"],
    setupFiles: ["./scripts/test-home-setup.ts"],
  },
});
