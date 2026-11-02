/**
 * Placement cost and patch size for a 2,000-thread list (ADR 0107, "Inbox, Snoozed, Settled").
 *
 *   node apps/daemon/bench/sidebar-tabs.ts [--old=$PWD/packages/ui-core/src/old-panel.ts]
 *
 * For --old, write main's client placement beside the module it imports first, and delete it
 * after: `git show <main>:packages/ui-core/src/threads-panel.ts > packages/ui-core/src/old-panel.ts`.
 *
 * After: the daemon places each changed thread (`PlacedEntries`) and sends it in a patch; the
 * client only groups and orders by the places (`threadTabs`). Before (with --old, the client
 * placement from main): every client ran `arrange` and `threadsPanel` over the whole list on
 * each update. Patch bytes before are the same patches without the fields this change adds.
 * Uses a temp SQLite store; sends no provider requests and opens no sockets.
 */
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Thread, ThreadId, type ServerMessage, type ThreadListEntry } from "@ace/protocol";
import { arrange, placeReader, standingReader, threadTabs } from "@ace/ui-core";
import { Store } from "../src/store.ts";
import { subscribe } from "../src/subscription.ts";
import { PlacedEntries, SidebarPlacement } from "../src/sidebar-placement.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key ?? "", value];
  }),
);
const count = Number(args.get("threads") ?? 2000);
const repeats = Number(args.get("repeats") ?? 200);
const now = 1_800_000_000_000;
const round = (n: number) => +n.toFixed(4);
function stats(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** The same message without what this change adds, as main sent it. */
function asBefore(message: ServerMessage): unknown {
  return JSON.parse(JSON.stringify(message), (key, value) =>
    key === "place" ||
    key === "revision" ||
    key === "epoch" ||
    key === "attention" ||
    key === "keep"
      ? undefined
      : value,
  );
}

const home = mkdtempSync(join(tmpdir(), "ace-tabs-bench-"));
const store = new Store(join(home, "events.sqlite"), () => {});
const projects = Array.from({ length: 12 }, (_, i) =>
  store.createWorkspace(`/repo-${i}`, `Repo ${i}`),
);
const states = [
  { state: "working", agents: 1 },
  { state: "needs_you", interactions: 1 },
  { state: "done" },
  { state: "failed" },
  { state: "waiting", on: "background_task" },
] as const;
for (let i = 0; i < count; i++) {
  const thread = Thread.parse({
    id: `t-${String(i).padStart(5, "0")}`,
    workspaceId: projects[i % 12],
    title: `Task ${i}`,
    provider: "codex",
    status: states[i % 7 === 0 ? 0 : i % 11 === 0 ? 1 : i % 13 === 0 ? 3 : i % 17 === 0 ? 4 : 2],
    createdAt: now - i * 60_000,
    updatedAt: now - i * 60_000,
    activityAt: now - i * 60_000,
    hasSentMessage: true,
    ...(i % 3 === 0 ? { readAt: now } : {}),
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }], now);
}
const placement = new SidebarPlacement(store.sidebarToken(), () => now);
const messages: ServerMessage[] = [];
const started = performance.now();
const stop = subscribe(
  store,
  "bench",
  { kind: "threads", window: { limit: 20 } },
  undefined,
  5000,
  (message) => messages.push(message),
  250,
  undefined,
  false,
  undefined,
  placement,
);
const snapshotMs = performance.now() - started;
const snapshot = messages[0];
if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads") throw new Error("snapshot");
const listed = Object.keys(snapshot.view.threads).length;
const resume = { revision: snapshot.view.window?.revision ?? 0, epoch: placement.epoch };

// One thread changes state at a time, cycling through the states.
const patchBytes: number[] = [];
const patchBytesBefore: number[] = [];
const deliverMs: number[] = [];
for (let i = 0; i < repeats; i++) {
  const id = ThreadId.parse(`t-${String((i * 37) % count).padStart(5, "0")}`);
  const before = messages.length;
  const at = performance.now();
  store.appendEvents(id, [{ type: "thread.updated", status: states[i % states.length] }], now);
  deliverMs.push(performance.now() - at);
  const patch = messages.at(-1);
  if (messages.length !== before + 1 || patch?.type !== "threads.patch") throw new Error("patch");
  patchBytes.push(bytes(patch));
  patchBytesBefore.push(bytes(asBefore(patch)));
}

// The daemon's placement work for one changed thread (its share of each update).
const places = new PlacedEntries(placement);
const entries = Object.values(snapshot.view.threads);
const placeMs: number[] = [];
for (let i = 0; i < repeats; i++) {
  const entry = { ...entries[i % entries.length]! };
  const at = performance.now();
  places.placed(entry);
  placeMs.push(performance.now() - at);
}

// Resume after one change vs a fresh window.
stop();
store.appendEvents(
  ThreadId.parse("t-00005"),
  [{ type: "thread.updated", status: { state: "done" } }],
  now,
);
const resumed: ServerMessage[] = [];
subscribe(
  store,
  "resume",
  { kind: "threads", window: { limit: 20, resume } },
  undefined,
  5000,
  (m) => resumed.push(m),
  250,
  undefined,
  false,
  undefined,
  placement,
)();
const fresh: ServerMessage[] = [];
subscribe(
  store,
  "fresh",
  { kind: "threads", window: { limit: 20 } },
  undefined,
  5000,
  (m) => fresh.push(m),
  250,
  undefined,
  false,
  undefined,
  placement,
)();

// Client work per list update, one entry replaced each time.
const list: ThreadListEntry[] = entries.map((entry) => Object.assign({}, entry));
const unplaced: ThreadListEntry[] = list.map((entry) => {
  const copy = Object.assign({}, entry);
  delete copy.place;
  return copy;
});
const clientAfterMs: number[] = [];
const clientBeforeMs: number[] = [];
const oldPath = args.get("old");
const old = oldPath ? await import(oldPath) : undefined;
const standing = standingReader({ baseline: 0, now });
const reader = placeReader({ fallback: { baseline: 0, now } });
for (let i = 0; i < repeats; i++) {
  const index = (i * 37) % list.length;
  list[index] = { ...list[index]! };
  unplaced[index] = { ...unplaced[index]! };
  let at = performance.now();
  threadTabs(list, reader);
  clientAfterMs.push(performance.now() - at);
  if (old) {
    at = performance.now();
    const arrangement = arrange(unplaced, { project: null, sortBy: "activity" }, now);
    const byId = new Map<string, ThreadListEntry>(unplaced.map((entry) => [entry.id, entry]));
    old.threadsPanel({
      arrangement,
      entry: (id: string) => byId.get(id),
      standing,
      sortBy: "activity",
    });
    clientBeforeMs.push(performance.now() - at);
  }
}

const result = {
  threads: count,
  listed,
  snapshot: {
    ms: round(snapshotMs),
    bytes: bytes(snapshot),
    bytesBefore: bytes(asBefore(snapshot)),
  },
  patch: {
    bytes: stats(patchBytes),
    bytesBefore: stats(patchBytesBefore),
    deliverMs: stats(deliverMs),
  },
  daemonPlaceOneThreadMs: stats(placeMs),
  resumeAfterOneChange: { bytes: bytes(resumed[0]), freshBytes: bytes(fresh[0]) },
  clientPerUpdateMs: {
    after: stats(clientAfterMs),
    before: old ? stats(clientBeforeMs) : undefined,
  },
};
console.log(JSON.stringify(result, null, 2));
store.close?.();
rmSync(home, { recursive: true, force: true });
