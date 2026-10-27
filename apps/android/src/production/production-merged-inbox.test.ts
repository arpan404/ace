import { expect, it } from "vitest";
import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { inboxSections, type InboxThread } from "@ace/ui-core/mobile";
import {
  machineLabelFor,
  mergedEntriesFor,
  mergedKeyFor,
  mergeInboxSections,
  mergedThreadsByKey,
  nextMergedReaderBudget,
  openKeyForRoutes,
  openKeyString,
  pairedHostsFor,
  pairedKeyFor,
  parseOpenKey,
  resolveOpenKeyForHosts,
  shouldResolveLeaseFor,
  showsMachineNames,
  type MergedReaderBudget,
  type ProductionOpenKey,
} from "./production-merged-inbox.ts";
import {
  MAX_AUTO_RECOVER_ATTEMPTS,
  shouldAutoRecoverReads,
  shouldPollAutoRecover,
} from "./production-inbox.ts";
import type { StartupRoute } from "../runtime/production-startup.ts";

const NOW = 1_000_000;

function entry(
  id: string,
  status: ThreadStatus,
  updatedAt: number = NOW,
  extra: Record<string, unknown> = {},
) {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    updatedAt,
    ...extra,
    id,
    status,
  });
}

function on(
  machineId: string,
  id: string,
  status: ThreadStatus,
  updatedAt: number = NOW,
): InboxThread {
  return { key: `${machineId}:${id}`, machineId, entry: entry(id, status, updatedAt) };
}

const paired: StartupRoute = { route: "paired" };
const revoked: StartupRoute = {
  route: "pairing",
  reason: "revoked",
  message: "This machine needs pairing again.",
};
const pin: StartupRoute = {
  route: "pairing",
  reason: "pin",
  message: "This computer's identity doesn't match the pairing link. Nothing was sent.",
};

it("merges per-machine sections into one inbox ordered by the shared rules", () => {
  const mac = [
    on("mac", "asks", { state: "needs_you", interactions: 1 }, NOW),
    on("mac", "old", { state: "done" }, NOW - 9 * 60_000),
  ];
  const linux = [
    on("linux", "fresh", { state: "done" }, NOW - 2 * 60_000),
    on("linux", "broke", { state: "failed" }, NOW - 4 * 60_000),
  ];
  const merged = mergeInboxSections([
    { machineId: "mac", sections: inboxSections(mac, [], NOW) },
    { machineId: "linux", sections: inboxSections(linux, [], NOW) },
  ]);
  expect(merged.map((section) => section.key)).toEqual(["needs-you", "done"]);
  expect(merged[0]?.rows.map((row) => row.key)).toEqual(["mac:asks", "linux:broke"]);
  expect(merged[1]?.rows.map((row) => row.key)).toEqual(["linux:fresh", "mac:old"]);
});

it("keeps the same thread id on two hosts as two distinct rows", () => {
  const merged = mergeInboxSections([
    {
      machineId: "mac",
      sections: inboxSections([on("mac", "t1", { state: "needs_you", interactions: 1 })], [], NOW),
    },
    {
      machineId: "linux",
      sections: inboxSections([on("linux", "t1", { state: "done" })], [], NOW),
    },
  ]);
  const keys = merged.flatMap((section) => section.rows.map((row) => row.key));
  expect(keys).toEqual(["mac:t1", "linux:t1"]);
  const entries = mergedEntriesFor(merged);
  const threadKeys = entries.flatMap((row) => (row.kind === "thread" ? [row.key] : []));
  expect(threadKeys).toEqual(["mac:t1", "linux:t1"]);
  expect(mergedKeyFor("mac", "t1")).toBe("mac:t1");
});

it("drops one machine's trouble while the other's rows stay", () => {
  const merged = mergeInboxSections([
    { machineId: "mac", sections: inboxSections([], [], NOW) },
    {
      machineId: "linux",
      sections: inboxSections([on("linux", "t1", { state: "done" })], [], NOW),
    },
  ]);
  expect(merged.flatMap((section) => section.rows.map((row) => row.key))).toEqual(["linux:t1"]);
  // A dead lease contributes no sections: nothing to merge, no crash.
  expect(mergeInboxSections([])).toEqual([]);
});

it("counts settled threads the daemon holds beyond the loaded window", () => {
  const merged = mergeInboxSections([
    {
      machineId: "mac",
      sections: [
        {
          key: "settled",
          label: "Settled",
          keys: ["mac:a"],
          ranks: ["r1"],
          total: 4,
        },
      ],
    },
  ]);
  expect(merged[0]?.rows).toHaveLength(1);
  expect(merged[0]?.total).toBe(4);
});

it("flattens merged sections into headings plus host-carrying thread rows", () => {
  const merged = mergeInboxSections([
    {
      machineId: "mac",
      sections: inboxSections([on("mac", "t1", { state: "done" })], [], NOW),
    },
  ]);
  expect(mergedEntriesFor(merged)).toEqual([
    { kind: "heading", id: "heading:done", title: "Done" },
    { kind: "thread", id: "t1", key: "mac:t1", machineId: "mac" },
  ]);
  expect(mergedEntriesFor([])).toEqual([]);
});

it("round-trips an open thread through its stable string identity", () => {
  const key: ProductionOpenKey = { machineId: "mac", id: "t:1" };
  expect(parseOpenKey(openKeyString(key))).toEqual(key);
  expect(parseOpenKey("no-newline")).toBeUndefined();
  expect(parseOpenKey("mac\n")).toBeUndefined();
});

it("routes the open thread to its own machine and closes it with that machine", () => {
  const open: ProductionOpenKey = { machineId: "mac", id: "t1" };
  expect(resolveOpenKeyForHosts(open, ["mac", "linux"])).toEqual(open);
  // Its machine removed or switched away: closed, never following another host.
  expect(resolveOpenKeyForHosts(open, ["linux"])).toBeNull();
  expect(resolveOpenKeyForHosts(open, [])).toBeNull();
  expect(resolveOpenKeyForHosts(null, ["mac"])).toBeNull();
});

it("keeps the open thread only while its own host stays paired", () => {
  const open: ProductionOpenKey = { machineId: "mac", id: "t1" };
  expect(openKeyForRoutes(open, (hostId) => (hostId === "mac" ? paired : revoked))).toEqual(open);
  // Its host revoked: closed. The other host staying paired changes nothing.
  expect(openKeyForRoutes(open, () => revoked)).toBeNull();
  expect(openKeyForRoutes(null, (hostId) => (hostId === "mac" ? paired : revoked))).toBeNull();
  expect(openKeyForRoutes(open, (hostId) => (hostId === "mac" ? pin : paired))).toBeNull();
});

it("resolves leases per host: one revocation never touches the other's rows", () => {
  expect(shouldResolveLeaseFor(paired)).toBe(true);
  expect(shouldResolveLeaseFor(revoked)).toBe(false);
  expect(shouldResolveLeaseFor(pin)).toBe(false);
  expect(
    shouldResolveLeaseFor({ route: "pairing", reason: "missing", message: "Pair again." }),
  ).toBe(false);
  expect(
    pairedHostsFor(["mac", "linux"], (hostId) => (hostId === "mac" ? paired : revoked)),
  ).toEqual(["mac"]);
  expect(pairedHostsFor([], () => paired)).toEqual([]);
});

it("shows machine names only to tell machines apart", () => {
  expect(showsMachineNames(1)).toBe(false);
  expect(showsMachineNames(2)).toBe(true);
  expect(machineLabelFor("mac", { mac: "Studio" })).toBe("Studio");
  expect(machineLabelFor("mac", {})).toBe("mac");
});

it("keys paired lists unambiguously so different host sets never share an effect key", () => {
  // Regression: `paired.join("")` collides on `["ab","c"]` vs `["a","bc"]`,
  // skipping the prune effect and leaving stale rows for a departed host.
  expect(pairedKeyFor(["ab", "c"])).not.toBe(pairedKeyFor(["a", "bc"]));
  expect(pairedKeyFor(["mac", "linux"])).toBe("mac\nlinux");
  expect(pairedKeyFor([])).toBe("");
  // Order matters: a host switch must re-key the effect.
  expect(pairedKeyFor(["a", "b"])).not.toBe(pairedKeyFor(["b", "a"]));
  // Single host and prefix hosts stay distinct.
  expect(pairedKeyFor(["ab"])).not.toBe(pairedKeyFor(["a", "b"]));
});

it("indexes merged rows by key without cross-machine id collisions", () => {
  const macThread = on("mac", "t1", { state: "done" });
  const linuxThread = on("linux", "t1", { state: "done" });
  const merged = mergeInboxSections([
    { machineId: "mac", sections: inboxSections([macThread], [], NOW) },
    { machineId: "linux", sections: inboxSections([linuxThread], [], NOW) },
  ]);
  const byKey = mergedThreadsByKey(
    { mac: { threads: [macThread] }, linux: { threads: [linuxThread] } },
    merged,
  );
  expect(byKey.get("mac:t1")).toBe(macThread);
  expect(byKey.get("linux:t1")).toBe(linuxThread);
  expect(byKey.size).toBe(2);
  // A row whose report is missing (revoked between merge and render) is skipped.
  const partial = mergedThreadsByKey({ mac: { threads: [macThread] } }, merged);
  expect(partial.get("mac:t1")).toBe(macThread);
  expect(partial.has("linux:t1")).toBe(false);
  expect(mergedThreadsByKey({}, []).size).toBe(0);
});

it("resets the merged reader budget on parent Retry so autos get a fresh bound", () => {
  // Regression: the merged child kept its own auto-recovery count and only
  // reset it on a healthy read, so after 5 exhausted autos a manual Retry
  // gave one re-resolve while autos stayed blocked — unlike the
  // single-machine views, whose Retry resets the budget to 0.
  const exhausted: MergedReaderBudget = {
    autoRecoveries: MAX_AUTO_RECOVER_ATTEMPTS,
    autoTick: MAX_AUTO_RECOVER_ATTEMPTS,
    epoch: 2,
  };
  // Still dead on the same epoch: no free refill without a Retry.
  expect(nextMergedReaderBudget(exhausted, 2, true)).toBe(exhausted);
  expect(shouldPollAutoRecover(exhausted.autoRecoveries)).toBe(false);
  expect(shouldAutoRecoverReads(true, "ready", exhausted.autoRecoveries)).toBe(false);
  // Parent Retry bumps the tick: budget resets even though still dead.
  const retried = nextMergedReaderBudget(exhausted, 3, true);
  expect(retried).toEqual({ autoRecoveries: 0, autoTick: 0, epoch: 3 });
  expect(shouldPollAutoRecover(retried.autoRecoveries)).toBe(true);
  expect(shouldAutoRecoverReads(true, "ready", retried.autoRecoveries)).toBe(true);
  // A healthy read resets without any Retry.
  const spent: MergedReaderBudget = { autoRecoveries: 2, autoTick: 2, epoch: 3 };
  expect(nextMergedReaderBudget(spent, 3, false)).toEqual({
    autoRecoveries: 0,
    autoTick: 0,
    epoch: 3,
  });
  // Fresh budget on the same epoch is referentially stable: no render churn.
  const fresh: MergedReaderBudget = { autoRecoveries: 0, autoTick: 0, epoch: 3 };
  expect(nextMergedReaderBudget(fresh, 3, false)).toBe(fresh);
});
