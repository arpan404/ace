import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, AgentItem, EventPayload, type Event, type ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { createDevThread } from "./commands.ts";
import { ManualClock } from "./engine/test-support.ts";
import { Store } from "./store.ts";
import { isStoreBusy, isStoreRetry } from "./store-busy.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
const unpinned = { persist() {}, committed() {} };

/** A store on manual time with `threads` threads, each with an empty streaming answer. */
function setup(threads = 1) {
  const home = mkdtempSync(join(tmpdir(), "ace-live-recovery-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const errors: unknown[] = [];
  const clock = new ManualClock();
  const open = () =>
    new Store(path, (error) => errors.push(error), {
      bufferScheduler: { delay: clock.setTimer },
    });
  let store = open();
  cleanup.push(() => void store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const ids = Array.from({ length: threads }, (_, index) => {
    const thread = createDevThread(store, workspace, `Thread ${index}`);
    store.appendEvents(thread.id, [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: "root",
          threadId: thread.id,
          parentId: null,
          origin: "root",
          native: { provider: "claude" },
          fidelity: "full",
          cwd: "/repo",
          status: { state: "starting" },
          createdAt: 1,
        }),
      },
      {
        type: "item.created",
        item: AgentItem.parse({
          id: `answer-${index}`,
          agentId: "root",
          type: "message",
          role: "assistant",
          complete: false,
          createdAt: 1,
          parts: [{ type: "text", text: "" }],
        }),
      },
    ]);
    return thread.id;
  });
  const live: Event[] = [];
  store.subscribe((events) => live.push(...events));
  const quarantined: ThreadId[] = [];
  store.onLiveWriteQuarantine((id) => quarantined.push(id));
  return {
    get store() {
      return store;
    },
    ids,
    path,
    clock,
    errors,
    live,
    quarantined,
    /** Change the schema through another connection, as an operator repairing it would. */
    repair(sql: string) {
      const db = new DatabaseSync(path);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
    async reopen() {
      await store.close();
      store = open();
    },
  };
}
const words = (count: number, prefix = "word") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index} `);
function stream(store: Store, id: ThreadId, index: number, appends: string[]): void {
  const payloads = appends.map((append) =>
    EventPayload.parse({
      type: "item.delta",
      itemId: `answer-${index}`,
      agentId: "root",
      field: "text",
      append,
    }),
  );
  store.prepareLiveWrite(Buffer.byteLength(JSON.stringify(payloads)));
  store.bufferLiveWrite(id, payloads, 1000, unpinned);
}
const text = (events: Event[], index = 0) =>
  events
    .map((event) =>
      event.payload.type === "item.delta" && event.payload.itemId === `answer-${index}`
        ? event.payload.append
        : "",
    )
    .join("");
function storedText(store: Store, id: ThreadId, index = 0): string {
  const item = store.snapshotThread(id).items[`answer-${index}`];
  if (item?.type !== "message") throw new Error("Missing answer");
  return item.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}
function failure(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the write to fail");
}

test("a burst of 64 KiB or more streamed inside a transaction commits once, publishes once and leaves the store writable", async () => {
  const state = setup();
  const [id] = state.ids;
  if (!id) throw new Error("Missing thread");
  const burst = words(60);
  // Provider SDK frames fold inside one transaction; this burst fills the buffer mid-fold.
  state.store.atomic(() => stream(state.store, id, 0, burst));
  stream(state.store, id, 0, ["tail"]);
  state.store.appendEvents(id, [{ type: "thread.updated", title: "Later write" }]);
  expect(state.errors).toEqual([]);
  expect(state.store.liveWriteBlocked()).toBe(false);
  expect(state.store.getThread(id)?.title).toBe("Later write");
  expect(text(state.live)).toBe(burst.join("") + "tail");
  await state.reopen();
  expect(storedText(state.store, id)).toBe(burst.join("") + "tail");
});

test("a burst written inside a transaction that rolls back is written again, exactly once", async () => {
  const state = setup();
  const [id] = state.ids;
  if (!id) throw new Error("Missing thread");
  const burst = words(60);
  expect(() =>
    state.store.atomic(() => {
      stream(state.store, id, 0, burst);
      throw new Error("later step failed");
    }),
  ).toThrow("later step failed");
  // The facts were already applied in memory: the pinned batch survives the rollback.
  state.store.flushLiveWrites();
  expect(state.store.hasLiveWrite(id)).toBe(false);
  expect(state.errors).toEqual([]);
  await state.reopen();
  expect(storedText(state.store, id)).toBe(burst.join(""));
});

test("a constraint failure in a pinned batch is not reported as busy and the store recovers once repaired", async () => {
  const state = setup();
  const [id] = state.ids;
  if (!id) throw new Error("Missing thread");
  state.store.atomic((db) =>
    db.exec(
      "CREATE TRIGGER refuse_delta BEFORE INSERT ON events WHEN NEW.type='item.delta' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ),
  );
  stream(state.store, id, 0, ["kept"]);
  const error = failure(() => state.store.flushLiveWrites());
  expect(isStoreBusy(error)).toBe(false);
  expect(isStoreRetry(error)).toBe(true);
  // Other writers wait for the batch rather than overtaking it.
  expect(isStoreBusy(failure(() => state.store.atomic(() => 1)))).toBe(false);
  expect(state.errors).toEqual([
    expect.objectContaining({ cause: expect.objectContaining({ message: "refused" }) }),
  ]);
  state.repair("DROP TRIGGER refuse_delta");
  state.clock.advance(state.clock.time + 100);
  expect(state.store.liveWriteBlocked()).toBe(false);
  expect(state.store.atomic(() => 1)).toBe(1);
  expect(state.quarantined).toEqual([]);
  await state.reopen();
  expect(storedText(state.store, id)).toBe("kept");
});

test("a pinned batch whose rows an earlier attempt already stored counts them as committed", () => {
  const state = setup();
  const [id] = state.ids;
  if (!id) throw new Error("Missing thread");
  stream(state.store, id, 0, ["kept"]);
  const event = state.live.find((live) => live.payload.type === "item.delta");
  if (!event) throw new Error("Missing live delta");
  // The row is already durable, as after a commit whose outcome the buffer never heard.
  state.repair(
    `INSERT INTO events VALUES (${event.seq}, '${event.id}', '${id}', ${event.at}, 'item.delta', '${JSON.stringify(event.payload)}')`,
  );
  const error = failure(() => state.store.flushLiveWrites());
  expect(isStoreBusy(error)).toBe(false);
  state.clock.advance(state.clock.time + 100);
  expect(state.store.liveWriteBlocked()).toBe(false);
  expect(state.quarantined).toEqual([]);
  expect(
    state.store
      .readEvents({ afterSeq: event.seq - 1, threadId: id, limit: 10 })
      .filter((stored) => stored.seq === event.seq),
  ).toEqual([event]);
});

test("a failed batch retries on a growing backoff instead of every 100 ms", () => {
  const state = setup();
  const [id] = state.ids;
  if (!id) throw new Error("Missing thread");
  state.store.atomic((db) =>
    db.exec(
      "CREATE TRIGGER refuse_delta BEFORE INSERT ON events WHEN NEW.type='item.delta' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ),
  );
  stream(state.store, id, 0, ["kept"]);
  const start = state.clock.time;
  failure(() => state.store.flushLiveWrites());
  const attempts = () => state.store.streamingMetrics().failures;
  state.clock.advance(start + 100);
  expect(attempts()).toBe(2);
  // The next attempt waits 200 ms, then 400 ms: no attempt in between.
  state.clock.advance(start + 299);
  expect(attempts()).toBe(2);
  state.clock.advance(start + 300);
  expect(attempts()).toBe(3);
  state.clock.advance(start + 699);
  expect(attempts()).toBe(3);
  state.clock.advance(start + 700);
  expect(attempts()).toBe(4);
  // Each failed attempt is reported once, with its delay and the real cause.
  expect(state.errors).toHaveLength(4);
  expect(String(state.errors.at(-1))).toContain("retrying in 800 ms");
  state.repair("DROP TRIGGER refuse_delta");
});

test("a batch that keeps failing quarantines only its thread and the store stays writable", async () => {
  const state = setup(2);
  const [broken, healthy] = state.ids;
  if (!broken || !healthy) throw new Error("Missing threads");
  state.store.atomic((db) =>
    db.exec(
      `CREATE TRIGGER refuse_delta BEFORE INSERT ON events WHEN NEW.type='item.delta' AND NEW.thread_id='${broken}' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    ),
  );
  stream(state.store, broken, 0, ["lost"]);
  stream(state.store, healthy, 1, ["saved"]);
  failure(() => state.store.flushLiveWrites());
  // Bounded: well within a minute of virtual time the batch settles without any repair.
  for (let step = 0; step < 60 && state.store.liveWriteBlocked(); step++)
    state.clock.advance(state.clock.time + 1000);
  expect(state.store.liveWriteBlocked()).toBe(false);
  expect(state.quarantined).toEqual([broken]);
  expect(state.store.atomic(() => 1)).toBe(1);
  stream(state.store, broken, 0, ["after"]);
  stream(state.store, healthy, 1, [" again"]);
  state.repair("DROP TRIGGER refuse_delta");
  state.store.flushLiveWrites();
  await state.reopen();
  expect(storedText(state.store, healthy, 1)).toBe("saved again");
  expect(storedText(state.store, broken, 0)).toBe("after");
});
