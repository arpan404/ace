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

/** The desktop app's update as the machine page shows it: downloaded, waiting for a restart. */
export function seedAppUpdate(daemon: FakeDaemon): void {
  daemon.seedServices({
    appUpdate: {
      version: "1.4.1",
      available: "1.4.2",
      downloaded: true,
      restartRequired: true,
      releaseUrl: "https://github.com/arpan404/ace/releases/tag/v1.4.2",
    },
  });
}

/**
 * ace's own update as the machine page's Software shows it: 0.0.19 on offer, run a step every
 * second once started, so the phone sees its progress and result.
 */
export function seedMachineUpdate(daemon: FakeDaemon): void {
  daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 0 });
  daemon.machineUpdate.autoplay(
    {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    1000,
  );
}
