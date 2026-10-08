import type { Thread } from "@ace/protocol";
import type { ThreadInit } from "../daemon.ts";

/*
 * Branch, pull request, worktree, machine and diff for the seeded threads, the way the daemon
 * projects them onto each thread (`details`). Threads run on this machine unless they name
 * another one.
 */

const buildBox = { host: "build-box.local", name: "build-box" };

interface Seed {
  branch: string;
  pr?: number;
  /** The PR merged, so the daemon settles the thread once it is done. */
  merged?: boolean;
  worktree?: boolean;
  remote?: boolean;
  diff?: [additions: number, deletions: number, files: number];
}

const seeds: Record<string, Seed> = {
  "thread-retry-budget": { branch: "fix/restart-retry", pr: 188, diff: [64, 12, 3] },
  "thread-sheet-rotate": { branch: "fix/sheet-rotate", remote: true },
  "thread-refund-tax": { branch: "fix/refund-tax", pr: 77, diff: [31, 18, 2] },
  "thread-dedupe": { branch: "fix/replay-dedupe", pr: 214, worktree: true, diff: [30, 7, 4] },
  "thread-resumable-streams": { branch: "relay/resumable-streams", worktree: true },
  "thread-install-page": { branch: "docs/install-daemon", diff: [120, 88, 1] },
  "thread-worktree-cleanup": { branch: "fix/worktree-cleanup", pr: 209, remote: true },
  "thread-pdf-locale": { branch: "fix/pdf-locale", pr: 74, diff: [22, 5, 2] },
  "thread-fan-out": { branch: "perf/fanout", remote: true },
  "thread-bump-codex": { branch: "chore/codex-048", pr: 212, merged: true },
  "thread-haptics": { branch: "feat/haptics" },
  "thread-flaky-restart": { branch: "fix/flaky-restart", pr: 205 },
  "thread-status-json": { branch: "feat/status-json", pr: 203 },
  "thread-mobile-tokens": { branch: "feat/theme-tokens" },
  "thread-refund-idempotency": { branch: "fix/refund-idempotency", pr: 71 },
  "thread-rate-limit-docs": { branch: "docs/rate-limits" },
  "thread-noise-vectors": { branch: "test/noise-vectors" },
  "thread-settings-keys": { branch: "feat/settings-keys", pr: 198 },
  "thread-snooze-threads": { branch: "feat/snooze", pr: 196 },
  "thread-push-approvals": { branch: "feat/push-approvals" },
  "thread-vat-rounding": { branch: "fix/vat-rounding", pr: 66 },
  "thread-codex-quickstart": { branch: "docs/codex-quickstart" },
  "thread-relay-metrics": { branch: "feat/relay-metrics", pr: 41 },
  "thread-replay-cursor": { branch: "fix/replay-cursor" },
  "thread-cold-start": { branch: "fix/cold-start-cap", worktree: true },
  "thread-checkout": { branch: "fix/flaky-checkout", pr: 81 },
  "thread-settings": { branch: "chore/settings-schema-v3", pr: 207 },
  "thread-router": { branch: "docs/router" },
};

function details(
  seed: Seed,
  workspaceId: string,
  here: { host: string; name: string },
): NonNullable<Thread["details"]> {
  return {
    branch: seed.branch,
    mode: seed.worktree ? "worktree" : "local",
    machine: seed.remote ? buildBox : here,
    ...(seed.pr
      ? {
          linkedPr: {
            number: seed.pr,
            state: seed.merged ? ("merged" as const) : ("open" as const),
            url: `https://github.com/acme/${workspaceId}/pull/${seed.pr}`,
          },
        }
      : {}),
    ...(seed.diff
      ? { diff: { additions: seed.diff[0], deletions: seed.diff[1], files: seed.diff[2] } }
      : {}),
    workspace: { id: workspaceId, name: workspaceId, path: `/Users/dev/${workspaceId}` },
    // Every seeded project has a GitHub origin, so Create PR has somewhere to go.
    repository: { forge: "github", host: "github.com", owner: "acme", name: workspaceId },
  };
}

/** A seeded thread with its card details, unless the scenario gave its own. */
export function withCardDetails(
  thread: ThreadInit,
  machine: { host: string; name: string },
): ThreadInit {
  // Checkouts use fake-host as their local placeholder; stamp the actual fake host at this edge.
  if (thread.details) {
    return thread.details.machine?.host === "fake-host"
      ? { ...thread, details: { ...thread.details, machine } }
      : thread;
  }
  const seed = Object.hasOwn(seeds, thread.id) ? seeds[thread.id] : undefined;
  return seed ? { ...thread, details: details(seed, thread.workspaceId, machine) } : thread;
}
