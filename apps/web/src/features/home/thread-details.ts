// TODO(client-gaps): feat/client-protocol-gaps projects branch, PR, worktree, machine and diff
// onto the thread list entry. Until then the card's third line comes from this source: the fake
// daemon's Home list in fake mode, nothing against a real daemon. Components depend only on
// `useThreadDetails`.

import type { ThreadDetails } from "@ace/ui-core";
import { useDaemonConnection } from "@/boot/connection.tsx";

export interface ThreadDetailsSource {
  details(threadId: string): ThreadDetails | undefined;
}

const fakeDetails: Record<string, ThreadDetails> = {
  "thread-retry-budget": { branch: "fix/restart-retry", pr: 188, diff: { added: 64, removed: 12 } },
  "thread-sheet-rotate": { branch: "fix/sheet-rotate", machine: "build-box" },
  "thread-refund-tax": { branch: "fix/refund-tax", pr: 77, diff: { added: 31, removed: 18 } },
  "thread-dedupe": {
    branch: "fix/replay-dedupe",
    pr: 214,
    worktree: true,
    diff: { added: 41, removed: 9 },
  },
  "thread-resumable-streams": { branch: "deck/resumable-streams", worktree: true },
  "thread-install-page": { branch: "docs/install-daemon", diff: { added: 120, removed: 88 } },
  "thread-worktree-cleanup": { branch: "fix/worktree-cleanup", pr: 209, machine: "build-box" },
  "thread-pdf-locale": { branch: "fix/pdf-locale", pr: 74, diff: { added: 22, removed: 5 } },
  "thread-fan-out": { branch: "perf/fanout", machine: "build-box" },
  "thread-bump-codex": { branch: "chore/codex-048", pr: 212 },
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
};

export const threadDetailsSource: ThreadDetailsSource = {
  details: (threadId) => (Object.hasOwn(fakeDetails, threadId) ? fakeDetails[threadId] : undefined),
};

export function useThreadDetails(threadId: string): ThreadDetails | undefined {
  const fake = useDaemonConnection().mode === "fake";
  return fake ? threadDetailsSource.details(threadId) : undefined;
}
