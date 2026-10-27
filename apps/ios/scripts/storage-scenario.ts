import type { FakeDaemon } from "@ace/fake-daemon";

/** Storage the phone's Storage page measures and cleans up: logs, a settled worktree, caches. */
export function seedStorage(daemon: FakeDaemon, now: number): void {
  const day = 86_400_000;
  const base = { threadIds: [], protections: [] };
  daemon.seedServices({
    storageDatabase: { bytes: 412 * 1024 ** 2, reclaimable: 38 * 1024 ** 2 },
    storageItems: [
      {
        ...base,
        id: "log-old",
        kind: "logs",
        label: "logs/ace.3.jsonl",
        bytes: 18 * 1024 ** 2,
        modifiedAt: now - 40 * day,
        fingerprint: "log-old",
        eligibleReason: "expired",
      },
      {
        ...base,
        id: "log-live",
        kind: "logs",
        label: "logs/ace.jsonl",
        bytes: 6 * 1024 ** 2,
        modifiedAt: now,
        fingerprint: "log-live",
        protections: ["leased"],
        eligibleReason: "expired",
      },
      {
        ...base,
        id: "cache-models",
        kind: "caches",
        label: "caches/models.json",
        bytes: 2 * 1024 ** 2,
        modifiedAt: now - 20 * day,
        fingerprint: "cache",
        eligibleReason: "expired",
      },
      {
        ...base,
        id: "tree-dirty",
        kind: "worktrees",
        label: "worktrees/ace-next/fix-relay",
        bytes: 340 * 1024 ** 2,
        modifiedAt: now - 60 * day,
        settledAt: now - 60 * day,
        fingerprint: "tree",
        protections: ["uncommitted"],
        eligibleReason: "task_finished",
      },
      {
        ...base,
        id: "shot-old",
        kind: "artifacts",
        label: "browser/recordings/checkout.webm",
        bytes: 54 * 1024 ** 2,
        modifiedAt: now - 45 * day,
        fingerprint: "shot",
        eligibleReason: "expired",
      },
    ],
  });
}
