// SPDX-License-Identifier: Apache-2.0

/**
 * One boot of the store cross gate's home (porting guide task 5.x-gate), in a process of its own:
 *
 *   process.execPath apps/daemon/src/store-cross-child.ts <boot> <phase> <home> <previous> <report>
 *
 * `previous` is the earlier boot's report, or `-` at boot 0; this boot's report goes to the last
 * argument, written as the last thing before the process exits or kills itself.
 * `store-cross-backend.process.test.ts` runs six of these in order and asserts the crossings: a
 * clean write, two kills inside a transaction (one in each writer mode), two kills with a
 * published live delta still buffered, and a clean final boot.
 *
 * Nothing opens a Store in the test's process: the switch is fixed per process, so only a fresh
 * child takes the backend the boot log gives boot _n_. On-disk checks go through `disk` (a
 * read-only observer beside the live Store) or `copyHome` + `diskCopy` (a home nobody holds), so a
 * reader never recovers or checkpoints a WAL the next backend has to recover.
 */
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Agent,
  AgentItem,
  EventPayload,
  ItemId,
  Thread,
  ThreadId,
  WorkspaceId,
  type Event,
} from "@ace/protocol";
import {
  canonicalWriterParts,
  storeBackend,
  storeWriterParts,
} from "@ace/provider-kit/native-switches";
import { z } from "zod";
import { Store } from "./store.ts";
import {
  copyHome,
  createThreads,
  disk,
  diskCopy,
  snapshot,
  snapshotText,
  stream,
  threadStream,
  type Assertions,
  type Disk,
  type StreamState,
  type Window,
} from "./store-cross-test-support.ts";
import { subscribe } from "./subscription.ts";
import { capabilities } from "./thread-column-samples.ts";

/** The four phases, in the order the test's six boots take them. */
export const Phase = z.enum(["write", "crash-in-transaction", "crash-with-buffered-tail", "final"]);
export type Phase = z.infer<typeof Phase>;

/** One live item the child reads back every boot: a message item and its thread. */
const LiveItem = z.object({ thread: z.string(), item: z.string() });
type LiveItem = z.infer<typeof LiveItem>;

const DiskRows = z.record(z.string(), z.unknown());
const DiskSchema = z.object({
  events: z.array(
    z.object({
      seq: z.number(),
      id: z.string(),
      thread_id: z.string(),
      type: z.string(),
      payload: z.string(),
    }),
  ),
  hostSequence: z.number(),
  recent: z.array(z.object({ workspace_id: z.string(), opened_at: z.number() })),
  threads: z.array(DiskRows),
  cold: z.array(DiskRows),
  revisions: z.array(z.object({ thread_id: z.string(), revision: z.number() })),
  stamps: z.array(DiskRows),
  walBytes: z.number(),
});

/** What a boot reads at its start and at its end, in one shape so the two compare exactly. */
const Observed = z.object({
  snapshot: z.unknown(),
  threads: z.array(z.unknown()),
  headSeq: z.number(),
  texts: z.record(z.string(), z.string()),
  revisions: z.array(z.number()),
});

/** One burst's stored delta rows: the compacted rows, in seq order. */
const Rows = z.array(z.object({ seq: z.number(), field: z.string(), append: z.string() }));

/** A boot's report: what this process found, wrote and saw, with nothing drawn from a clock. */
export const Report = z.object({
  boot: z.number(),
  phase: Phase,
  pid: z.number(),
  /** The writer parts this boot actually ran, in canonical order. */
  parts: z.string(),
  backend: z.enum(["native", "typescript"]),
  state: z.object({
    seed: z.number(),
    ids: z.array(z.string()),
    items: z.record(z.string(), z.array(z.string())),
    workspaces: z.array(z.string()),
  }),
  live: z.array(LiveItem),
  /** Every sequence this boot published. */
  published: z.array(z.number()),
  /** What the previous process left, read from a copy taken before this boot's open. */
  preOpen: DiskSchema.optional(),
  requiredDisk: DiskSchema,
  opened: Observed.optional(),
  closed: Observed.optional(),
  durable: DiskSchema,
  crashing: z.enum(["transaction", "tail"]).optional(),
  walBefore: z.number().optional(),
  walInside: z.number().optional(),
  killDisk: DiskSchema.optional(),
  lostFrom: z.number().optional(),
  lostThrough: z.number().optional(),
  tailThread: z.string().optional(),
  probeFirst: z.string().optional(),
  rows: z.record(z.string(), Rows),
  /** The six required writes' own sequences, in the order they were written. */
  requiredSeqs: z.array(z.number()),
});
export type Report = z.infer<typeof Report>;

/**
 * Burst 1: forty deltas of 10 to 200 bytes from a fixed list, so adjacent merges make rows of many
 * inputs and the row boundaries are the same in every boot. The list is chosen against the
 * buffer's own limit: its weight is `8 × JSON bytes + 512` per event and it flushes at 64 KiB
 * (`live-write-buffer.ts:155`), which this batch reaches partway through whichever mode writes
 * it. The flush lands on the same append for a three- to six-digit sequence, so the boundaries
 * don't drift with a boot's sequence numbers.
 *
 * The 4,096-byte merge rule itself can't be reached here: a batch that stays under 64 KiB holds
 * at most about 2 KiB of appends, and 4,096 bytes of appends of 200 bytes or less weigh more
 * than 64 KiB before they can merge. `store-live-write-recovery` and the compaction tests prove
 * that rule; this burst proves that many inputs merge and that the boundaries are the same
 * whichever backend and whicher boot wrote them.
 */
export const burstOneAppends: readonly string[] = Array.from({ length: 40 }, (_, i) =>
  String.fromCharCode(97 + (i % 26)).repeat(10 + ((i * 61) % 191)),
);
/** The other thread's deltas in burst 1's turn, on its own live item. */
export const alongsideAppends: readonly string[] = Array.from({ length: 10 }, (_, i) =>
  String.fromCharCode(65 + i).repeat(64),
);

/** Burst 2: a surrogate pair split across two appends, then a lone surrogate. */
export const burstTwoAppends: readonly string[] = ["\ud83d", "\ude00", "\ud800"];

/**
 * Burst 3: the first count of 3,000-byte deltas whose last call makes the buffer's weight reach
 * 64 KiB (`live-write-buffer.ts:155`), measured once in TypeScript mode. Two adjacent deltas total
 * 6,000 bytes, past the 4,096-byte merge limit, so nothing merges.
 */
export const thresholdBurstCount = 3;
export const thresholdAppend = (call: number): string =>
  String.fromCharCode(65 + ((call - 1) % 26)).repeat(3000);

/** Burst 4: a delta on the item's second field, then one on its first. */
export const burstFourAppends: readonly { field: "reasoning" | "text"; append: string }[] = [
  { field: "reasoning", append: "planned first, then spoke" },
  { field: "text", append: "the answer" },
];

/** The five buffered tail deltas, under 1 KiB together. */
export const tailAppends: readonly string[] = Array.from({ length: 5 }, (_, i) =>
  `tail ${i} `.padEnd(100, "."),
);

/** The required writes' fixed values, so a boot's columns and the test's expectations agree. */
export const requiredWrites = {
  queue: { revision: 1, pendingCount: 1, paused: true, reason: "manual", resumeAt: null },
  client: {
    pinned: true,
    details: { mode: "worktree", worktree: "/w/cross", ahead: 1 },
    live: { subagentCount: 1, waitingOn: 1 },
  },
  thread: { title: "Cross gate", status: { state: "working", agents: 1 } },
} as const;

/** The text each burst item's script joins to, for the field `snapshotText` reads. */
export function burstTexts(): Record<string, string> {
  return {
    "1": burstOneAppends.join(""),
    "2": burstTwoAppends.join(""),
    "3": Array.from({ length: thresholdBurstCount }, (_, i) => thresholdAppend(i + 1)).join(""),
    "4": burstFourAppends.find(({ field }) => field === "text")?.append ?? "",
  };
}

/** Every append burst `k` makes, in order, as the field and append a stored row carries. */
export function burstScript(k: number): readonly { field: string; append: string }[] {
  if (k === 1) return burstOneAppends.map((append) => ({ field: "text", append }));
  if (k === 2) return burstTwoAppends.map((append) => ({ field: "text", append }));
  if (k === 3)
    return Array.from({ length: thresholdBurstCount }, (_, i) => ({
      field: "text",
      append: thresholdAppend(i + 1),
    }));
  if (k === 4) return burstFourAppends.map(({ field, append }) => ({ field, append }));
  throw new Error(`No burst ${k}`);
}

const assertions: Assertions = {
  equal: (actual, expected, label) =>
    assert.deepStrictEqual(json(actual), json(expected), `${label}: ${describe(actual)}`),
  strictEqual: (actual, expected, label) =>
    assert.deepStrictEqual(actual, expected, `${label}: ${describe(actual)}`),
  throws: (run, message) => assert.throws(run, { message }),
};

function json(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.slice(0, 300);
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing value ${index}`);
  return value;
}

/** The sidebar windows the driver reads, so a boot's reads compare with the driver's. */
function windowsOf(state: StreamState): Window[] {
  return [
    { limit: 3 },
    { limit: 20 },
    { limit: 2, project: state.workspaces[0] ?? "" },
    { limit: 5, archived: true },
  ];
}

function observe(store: Store, state: StreamState, live: readonly LiveItem[]): Report["opened"] {
  const snap = snapshot(store, windowsOf(state));
  return {
    snapshot: snap,
    threads: state.ids.map((id) => store.getThread(id)),
    headSeq: store.headSeq(),
    texts: Object.fromEntries(
      live.map((entry) => [
        entry.item,
        snapshotText(store, ThreadId.parse(entry.thread), entry.item),
      ]),
    ),
    revisions: snap.sidebar.map((page) => {
      const revision = page.window.revision;
      if (revision === undefined) throw new Error("A sidebar window read no revision");
      return revision;
    }),
  };
}

function emptyItem(id: string, agentId: string): EventPayload {
  return {
    type: "item.created",
    item: AgentItem.parse({
      id,
      agentId,
      type: "message",
      role: "assistant",
      complete: false,
      createdAt: 1,
      parts: [{ type: "text", text: "" }],
    }),
  };
}

function delta(
  itemId: string,
  agentId: string,
  field: "text" | "reasoning" | "output",
  append: string,
): EventPayload {
  return EventPayload.parse({ type: "item.delta", itemId, agentId, field, append });
}

function thread(
  id: string,
  workspaceId: string,
  extra: Record<string, unknown> = {},
): EventPayload {
  return {
    type: "thread.created",
    thread: Thread.parse({
      id,
      workspaceId,
      title: `Thread ${id}`,
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    }),
  };
}

/** The stored `item.delta` rows of `itemId`, as the compacted rows in seq order. */
function rowsOf(path: string, itemId: string): z.infer<typeof Rows> {
  return disk(path).events.flatMap((row) => {
    const payload = EventPayload.parse(JSON.parse(row.payload));
    if (payload.type !== "item.delta" || payload.itemId !== itemId) return [];
    return [{ seq: row.seq, field: payload.field as string, append: payload.append }];
  });
}

function stateOf(report: Report): StreamState {
  return {
    seed: report.state.seed,
    ids: report.state.ids.map((id) => ThreadId.parse(id)),
    items: Object.fromEntries(
      Object.entries(report.state.items).map(([id, items]) => [
        id,
        items.map((item) => ItemId.parse(item)),
      ]),
    ),
    workspaces: report.state.workspaces.map((id) => WorkspaceId.parse(id)),
  };
}

/** A probe of the lost thread, from the published cursor the next boot must still answer. */
function probeFirst(store: Store, previous: Report): string | undefined {
  if (previous.crashing !== "tail") return undefined;
  if (previous.lostThrough === undefined || previous.tailThread === undefined) return undefined;
  const messages: { type: string }[] = [];
  const stop = subscribe(
    store,
    "probe",
    { kind: "thread", threadId: ThreadId.parse(previous.tailThread) },
    previous.lostThrough,
    1000,
    (message) => messages.push(message),
  );
  stop();
  return messages[0]?.type;
}

async function main(): Promise<void> {
  const [bootText, phaseText, home, previousPath, reportPath] = process.argv.slice(2);
  if (
    bootText === undefined ||
    phaseText === undefined ||
    home === undefined ||
    previousPath === undefined ||
    reportPath === undefined
  )
    throw new Error("usage: store-cross-child.ts <boot> <phase> <home> <previous> <report>");
  const boot = Number(bootText);
  const phase = Phase.parse(phaseText);
  const path = join(home, "events.sqlite");
  const previous =
    previousPath === "-"
      ? undefined
      : Report.parse(JSON.parse(readFileSync(previousPath, "utf8")) as unknown);

  /** This boot's report, written once as the last thing before it exits or kills itself. */
  const writeReport = (built: Record<string, unknown>): void =>
    writeFileSync(reportPath, JSON.stringify(Report.parse(built)));

  // 1. The home the previous process left, copied before anything opens it, so the target backend
  // does its own WAL recovery on the original. The copy is read only after the open, as `preOpen`.
  const copy = join(home, `pre-open-${boot}`);
  if (boot > 0) copyHome(home, copy);
  const store = new Store(path);
  const preOpen: Disk | undefined = boot > 0 ? diskCopy(copy) : undefined;

  // 2. The store is open: record this boot's mode, and everything it publishes from here on.
  const parts = canonicalWriterParts([...storeWriterParts()].join(","));
  const backend = storeBackend();
  const db = store.atomic((handle) => handle);
  const published: number[] = [];
  store.subscribe((events) => {
    for (const event of events) published.push(event.seq);
  });

  // The target Store must read every event the previous process left, before this boot writes any.
  const left = preOpen?.events ?? [];
  assert.deepStrictEqual(
    store.readEvents({ afterSeq: 0, limit: Math.max(1, left.length + 1) }).map((event) => ({
      seq: event.seq,
      id: event.id,
      thread_id: event.threadId,
      type: event.payload.type,
      payload: json(event.payload),
    })),
    left.map((row) => ({
      seq: row.seq,
      id: row.id,
      thread_id: row.thread_id,
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
    })),
    "the reopened store reads every event the previous process left",
  );

  // 3, 4.1. The state earlier boots left, what this boot reads before it writes, and boot 0's seed.
  let state: StreamState;
  let live: LiveItem[];
  let opened: Report["opened"];
  let probe: string | undefined;
  if (boot === 0) {
    state = createThreads(store, home, 21, 10);
    live = [
      { thread: at(state.ids, 0), item: "answer-0" },
      { thread: at(state.ids, 1), item: "answer-1" },
    ];
    // 4.1 The two threads' message items the live bursts append beside.
    store.appendEvents(at(state.ids, 0), [emptyItem("answer-0", "root-0")], 3e12);
    store.appendEvents(at(state.ids, 1), [emptyItem("answer-1", "root-1")], 3e12);
  } else {
    if (previous === undefined) throw new Error("A boot past the first needs the previous report");
    state = stateOf(previous);
    live = [...previous.live];
    opened = observe(store, state, live);
    probe = probeFirst(store, previous);
  }

  // 4.2 to 4.7. The required writes, in the same order in every boot. Their own rows are
  // recorded by sequence: a write may append a live-metadata follow-up beside them.
  const requiredSeqs: number[] = [];
  const wrote = (events: Event[]): void => {
    const first = events[0];
    if (first === undefined) throw new Error("A required write stored nothing");
    requiredSeqs.push(first.seq);
  };
  {
    const at7 = 7e12 + boot;
    const recent = ThreadId.parse(`recent-${boot}`);
    const imported = ThreadId.parse(`imported-${boot}`);
    // 4.2 An ordinary thread: it makes its workspace the most recently used one.
    wrote(
      store.appendEvents(
        recent,
        [thread(`recent-${boot}`, at(state.workspaces, boot % 3))],
        4e12 + boot,
      ),
    );
    // 4.3 An imported one: it started nothing now, so `workspace_recent` must not move.
    wrote(
      store.appendEvents(
        imported,
        [
          thread(`imported-${boot}`, at(state.workspaces, (boot + 1) % 3), {
            imported: {
              sourceId: `source-${boot}`,
              instanceId: "instance",
              native: { provider: "codex", nativeId: `native-${boot}` },
              importedAt: 1,
            },
          }),
        ],
        5e12 + boot,
      ),
    );
    // 4.4 The fold's root-agent rule, on the thread from 4.2.
    wrote(
      store.appendEvents(
        recent,
        [
          {
            type: "agent.created",
            agent: Agent.parse({
              id: `root-recent-${boot}`,
              threadId: recent,
              parentId: null,
              origin: "root",
              native: { provider: "codex" },
              fidelity: "full",
              cwd: "/repo",
              status: { state: "starting" },
              createdAt: 1,
            }),
          },
        ],
        at7,
      ),
    );
    // 4.5 Fold rule 1: the queue, on thread 0.
    wrote(
      store.appendEvents(
        at(state.ids, 0),
        [{ type: "queue.updated", ...requiredWrites.queue }],
        at7 + 1,
      ),
    );
    // 4.6 Fold rule 2: pinned, details and live in one change, on thread 1.
    wrote(
      store.appendEvents(
        at(state.ids, 1),
        [{ type: "thread.client.updated", changes: { ...requiredWrites.client } }],
        at7 + 2,
      ),
    );
    // 4.7 Fold rule 3: title, status and capabilities in one change, on thread 2.
    wrote(
      store.appendEvents(
        at(state.ids, 2),
        [
          {
            type: "thread.updated",
            title: requiredWrites.thread.title,
            status: requiredWrites.thread.status,
            capabilities: capabilities(2),
          },
        ],
        at7 + 3,
      ),
    );
  }
  const requiredDisk = disk(path);

  // 5. The seeded stream, folded against the TypeScript projection on every step.
  state.seed = 21 + boot;
  const driver = threadStream(store, db, state, assertions, `b${boot}-`);
  for (let step = 1; step <= 60; step++) driver.step(`boot ${boot}, step ${step}`);

  // 6. The live bursts: fixed scripts, the same in every boot, on fresh items created first.
  const rows: Record<string, z.infer<typeof Rows>> = {};
  const burstThread = at(state.ids, 0);
  /** A fresh live item on thread 0, committed empty before its burst; returns its id. */
  const burstItem = (item: string): string => {
    live.push({ thread: burstThread, item });
    store.appendEvents(burstThread, [emptyItem(item, "root-0")]);
    return item;
  };
  {
    // 6.1 Adjacent merges up to and across the 4,096-byte rule, beside another thread's deltas.
    const item = burstItem(`live-${boot}-1`);
    for (const append of burstOneAppends)
      stream(store, burstThread, [delta(item, "root-0", "text", append)]);
    for (const append of alongsideAppends)
      stream(store, at(state.ids, 1), [delta("answer-1", "root-1", "text", append)]);
    store.flushLiveWrites();
    rows["1"] = rowsOf(path, item);
  }
  {
    // 6.2 A surrogate pair split across two appends, then a lone surrogate.
    const item = burstItem(`live-${boot}-2`);
    for (const append of burstTwoAppends)
      stream(store, burstThread, [delta(item, "root-0", "text", append)]);
    store.flushLiveWrites();
    rows["2"] = rowsOf(path, item);
  }
  {
    // 6.3 The threshold burst: nothing on disk until the final append, all of it then, no flush.
    const item = burstItem(`live-${boot}-3`);
    const seqs: number[] = [];
    for (let call = 1; call <= thresholdBurstCount; call++) {
      const before = published.length;
      stream(store, burstThread, [delta(item, "root-0", "text", thresholdAppend(call))]);
      const fresh = published.slice(before);
      assert.strictEqual(fresh.length, 1, "the threshold burst published a call more than once");
      seqs.push(at(fresh, 0));
      const stored = new Set(disk(path).events.map((row) => row.seq));
      const onDisk = seqs.filter((seq) => stored.has(seq)).length;
      assert.strictEqual(
        onDisk,
        call === thresholdBurstCount ? thresholdBurstCount : 0,
        "threshold burst did not flush on its final append",
      );
    }
    rows["3"] = rowsOf(path, item);
    assert.deepStrictEqual(
      rows["3"],
      seqs.map((seq, index) => ({ seq, field: "text", append: thresholdAppend(index + 1) })),
      "the threshold burst stored rows that are not its inputs",
    );
  }
  {
    // 6.4 A delta on the second field, then one on the first.
    const item = burstItem(`live-${boot}-4`);
    for (const { field, append } of burstFourAppends)
      stream(store, burstThread, [delta(item, "root-0", field, append)]);
    store.flushLiveWrites();
    rows["4"] = rowsOf(path, item);
  }

  const base = (): Record<string, unknown> => ({
    boot,
    phase,
    pid: process.pid,
    parts,
    backend,
    state,
    live,
    published,
    preOpen,
    opened,
    requiredDisk,
    probeFirst: probe,
    rows,
    requiredSeqs,
  });

  // 7. The ending the phase asks for.
  if (phase === "write" || phase === "final") {
    store.flushLiveWrites();
    const closed = observe(store, state, live);
    await store.close();
    const durable = join(home, `durable-${boot}`);
    copyHome(home, durable);
    writeReport({ ...base(), closed, durable: diskCopy(durable) });
    return;
  }
  if (phase === "crash-in-transaction") {
    store.flushLiveWrites();
    const durable = disk(path);
    const closed = observe(store, state, live);
    // Control the WAL: whether uncommitted pages reach it depends on the cache and space reuse.
    db.exec("PRAGMA busy_timeout=0");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.exec("PRAGMA busy_timeout=5000");
    assert.strictEqual(
      Number(checkpoint?.["busy"] ?? 1),
      0,
      "precondition: the WAL could not be truncated before the transaction",
    );
    db.exec("PRAGMA cache_size = -256");
    // Enable mid-transaction spilling explicitly: node:sqlite's build defaults its cache_spill
    // threshold to 20,000 pages, far above the 4 MiB this transaction writes, so the cache size
    // alone never reaches the WAL. (0 is not the portable spelling: the addon's newer SQLite
    // reads 0 as "never spill".)
    db.exec("PRAGMA cache_spill = ON");
    const walBefore = disk(path).walBytes;
    assert.strictEqual(walBefore, 0, "precondition: the WAL was not empty before the transaction");
    store.atomic(() => {
      const crash = ThreadId.parse(`crash-${boot}`);
      store.appendEvents(
        crash,
        [thread(`crash-${boot}`, at(state.workspaces, boot % 3))],
        6e12 + boot,
      );
      const huge = "x".repeat(64 * 1024);
      store.appendEvents(
        at(state.ids, 3),
        Array.from({ length: 64 }, (_, index) => ({
          type: "item.created" as const,
          item: AgentItem.parse({
            id: `crash-${boot}-${index}`,
            agentId: "root-3",
            type: "message",
            role: "assistant",
            complete: false,
            createdAt: 1,
            parts: [{ type: "text", text: huge }],
          }),
        })),
        6e12 + boot,
      );
      store.appendEvents(
        at(state.ids, 4),
        [{ type: "thread.updated", title: "Never committed" }],
        6e12 + boot,
      );
      const walInside = disk(path).walBytes;
      writeReport({ ...base(), closed, durable, crashing: "transaction", walBefore, walInside });
      assert.ok(walInside > 0, "precondition: no uncommitted frames reached the WAL");
      process.kill(process.pid, "SIGKILL");
    });
    return;
  }
  // The tail item is committed empty before the observation, so it reads "" after the crash.
  const tail = `tail-${boot}`;
  live.push({ thread: at(state.ids, 4), item: tail });
  store.appendEvents(at(state.ids, 4), [emptyItem(tail, "root-4")], 9e12 + boot);
  store.flushLiveWrites();
  const durable = disk(path);
  const closed = observe(store, state, live);
  const before = published.length;
  for (const append of tailAppends)
    stream(store, at(state.ids, 4), [delta(tail, "root-4", "text", append)]);
  const lost = published.slice(before);
  assert.strictEqual(lost.length, tailAppends.length, "precondition: the tail was not published");
  const lostFrom = at(lost, 0);
  const lostThrough = at(lost, lost.length - 1);
  assert.ok(store.hasLiveWrite(at(state.ids, 4)), "precondition: the tail was not buffered");
  const killDisk = disk(path);
  const stored = new Set(killDisk.events.map((row) => row.seq));
  assert.ok(
    lost.every((seq) => !stored.has(seq)),
    "precondition: a buffered tail row reached the disk",
  );
  assert.ok(
    killDisk.hostSequence >= lostThrough,
    "precondition: the reservation does not cover the published tail",
  );
  writeReport({
    ...base(),
    closed,
    durable,
    crashing: "tail",
    killDisk,
    lostFrom,
    lostThrough,
    tailThread: at(state.ids, 4),
  });
  process.kill(process.pid, "SIGKILL");
}

if (import.meta.main) await main();
