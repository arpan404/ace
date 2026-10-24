import { afterEach, expect, test } from "vitest";
import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
import type { Fact } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import type { Event } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { harness, start, end, question, ManualClock } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** SDK-channel frames, as Claude sends them: each frame carries its own bundle of facts. */
function sdkFrames() {
  const bundles = new Map<number, Fact[]>();
  let seq = 0;
  return {
    frame(...facts: Fact[]): Frame {
      bundles.set(++seq, facts);
      const payload = new ProviderPayload(JSON.stringify({ bundle: seq }));
      return { seq, t: seq, dir: "recv", channel: "sdk", data: payload.data, payload };
    },
    translate(frame: Frame): Fact[] {
      return structuredClone(bundles.get(frame.seq) ?? []);
    },
  };
}
const signal: Fact = { type: "signal", agent: "root" };
const answer: Fact = {
  type: "item.upsert",
  agent: "root",
  item: "answer",
  draft: { type: "message", role: "assistant", parts: [{ type: "text", text: "" }] },
};
const delta = (text: string): Fact => ({
  type: "item.delta",
  agent: "root",
  item: "answer",
  field: "text",
  append: text,
});
const tool: Fact = {
  type: "item.upsert",
  agent: "root",
  item: "read",
  draft: {
    type: "tool_call",
    call: { kind: "file.read", status: "running", title: "Read file" },
  },
};

async function session() {
  const frames = sdkFrames();
  const buffer = new ManualClock();
  const h = await harness([{ on: "send", frames: [frames.frame(start, answer)] }], frames, {
    provider: "claude",
    silenceMs: 60_000,
    storeOptions: { bufferScheduler: { delay: buffer.setTimer } },
  });
  cleanups.push(h.close);
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider");
  const published: Event[] = [];
  const stop = h.store.subscribe((events) => published.push(...events));
  cleanups.push(async () => stop());
  /** What another process reading the file would find: committed rows only. */
  const durable = () => {
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      return db
        .prepare("SELECT seq, id, type FROM events WHERE thread_id=? ORDER BY seq")
        .all(id)
        .map((row) => ({ seq: Number(row.seq), id: String(row.id), type: String(row.type) }));
    } finally {
      db.close();
    }
  };
  return { ...h, id, context, frames, buffer, published, durable };
}

/** Everything the turn left behind that a client can read, without engine-made ids. */
function outcome(h: Awaited<ReturnType<typeof session>>) {
  const items = h.store.readItems(h.id, h.store.headSeq() + 1, 50).items;
  return {
    status: h.store.getThread(h.id)?.status,
    items: items.map((item) =>
      item.type === "message"
        ? { type: item.type, role: item.role, parts: item.parts }
        : item.type === "tool_call"
          ? { type: item.type, call: item.call }
          : { type: item.type },
    ),
    control: h.durable().flatMap((row) => (row.type === "item.delta" ? [] : [row.type])),
  };
}

const turn = (frames: ReturnType<typeof sdkFrames>) => [
  frames.frame(signal),
  frames.frame(signal),
  frames.frame(signal, delta("Reading ")),
  frames.frame(signal),
  frames.frame(signal, delta("the file")),
  frames.frame(signal, tool),
  frames.frame(signal),
  frames.frame(signal),
  frames.frame(signal, end),
];

test("a run of transport signals costs one write, not a transaction per frame", async () => {
  const h = await session();
  // The first live write reserves a sequence range once; measure after it.
  await h.context.onFrame(h.frames.frame(signal));
  const before = h.store.streamingMetrics().transactions;
  for (let index = 0; index < 20; index++) await h.context.onFrame(h.frames.frame(signal));
  expect(h.store.streamingMetrics().transactions - before).toBe(0);
  await h.context.onFrame(h.frames.frame(signal, tool));
  await h.engine.flush();
  // The pinned signals, the tool frame and its queue sync; never one per signal.
  expect(h.store.streamingMetrics().transactions - before).toBeLessThanOrEqual(3);
  expect(h.errors).toEqual([]);
});

test("a burst of frames leaves the same thread, transcript and events as one frame at a time", async () => {
  const paced = await session();
  for (const frame of turn(paced.frames)) {
    await paced.context.onFrame(frame);
    paced.buffer.advance(paced.buffer.time + 20);
  }
  await paced.engine.flush();
  const burst = await session();
  await Promise.all(turn(burst.frames).map((frame) => burst.context.onFrame(frame)));
  await burst.engine.flush();
  expect(outcome(burst)).toEqual(outcome(paced));
  expect(outcome(paced)).toMatchObject({
    status: { state: "done" },
    items: expect.arrayContaining([
      { type: "message", role: "assistant", parts: [{ type: "text", text: "Reading the file" }] },
    ]),
  });
  for (const h of [paced, burst]) {
    const stored = new Map(h.durable().map((row) => [row.seq, row]));
    // Every control event a client received is stored under the same sequence and id.
    for (const event of h.published.filter((sent) => sent.payload.type !== "item.delta"))
      expect(stored.get(event.seq)).toEqual({
        seq: event.seq,
        id: event.id,
        type: event.payload.type,
      });
    const seqs = [...stored.keys()];
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(h.errors).toEqual([]);
  }
});

test("an approval after buffered signals is published and stored before its frame settles", async () => {
  const h = await session();
  for (let index = 0; index < 5; index++) await h.context.onFrame(h.frames.frame(signal));
  await h.context.onFrame(h.frames.frame(signal, question));
  // No buffer timer has run: the approval needs no flush window to reach anyone.
  expect(h.published.map((event) => event.payload.type)).toContain("interaction.opened");
  const opened = h.published.find((event) => event.payload.type === "interaction.opened");
  expect(h.durable()).toContainEqual({
    seq: opened?.seq,
    id: opened?.id,
    type: "interaction.opened",
  });
  expect(h.store.getThread(h.id)?.status.state).toBe("needs_you");
});

test("a delta that follows buffered signals is stored within the delta bound", async () => {
  const h = await session();
  await h.context.onFrame(h.frames.frame(signal));
  await h.context.onFrame(h.frames.frame(signal, delta("token")));
  const delivered = h.published.find((event) => event.payload.type === "item.delta");
  expect(delivered).toBeDefined();
  h.buffer.advance(h.buffer.time + 75);
  expect(h.durable().findLast((row) => row.type === "item.delta")?.seq).toBe(delivered?.seq);
  expect(h.errors).toEqual([]);
});

test("buffered signals are written by their own timer when nothing else commits", async () => {
  const h = await session();
  const before = h.store.streamingMetrics().flushes;
  await h.context.onFrame(h.frames.frame(signal));
  h.buffer.advance(h.buffer.time + 999);
  expect(h.store.streamingMetrics().flushes).toBe(before);
  h.buffer.advance(h.buffer.time + 1);
  expect(h.store.streamingMetrics().flushes).toBe(before + 1);
  expect(h.store.liveWriteBlocked()).toBe(false);
});

test("held writes keep buffered signals pinned instead of failing other writers", async () => {
  const h = await session();
  await h.context.onFrame(h.frames.frame(signal));
  h.store.setHistoryWriting(true);
  try {
    expect(h.store.atomic(() => "written")).toBe("written");
  } finally {
    h.store.setHistoryWriting(false);
  }
  await h.context.onFrame(h.frames.frame(signal, end));
  await h.engine.flush();
  expect(h.store.getThread(h.id)?.status.state).toBe("done");
  expect(h.errors).toEqual([]);
});

test("a crash while signals are buffered recovers the last committed thread", async () => {
  const h = await session();
  await h.context.onFrame(h.frames.frame(signal, delta("partial")));
  h.buffer.advance(h.buffer.time + 75);
  for (let index = 0; index < 5; index++) await h.context.onFrame(h.frames.frame(signal));
  const committed = h.durable();
  // A copy of the file as a killed daemon leaves it: the pinned signals never reached it.
  const crashPath = join(h.home, "crash.sqlite");
  const source = new DatabaseSync(h.path, { readOnly: true });
  try {
    await backup(source, crashPath);
  } finally {
    source.close();
  }
  const store = new Store(crashPath);
  cleanups.push(() => store.close());
  // The copy holds everything committed before the kill: the stored delta and its transcript.
  expect(store.readItems(h.id, store.headSeq() + 1, 50).items).toContainEqual(
    expect.objectContaining({ type: "message", parts: [{ type: "text", text: "partial" }] }),
  );
  const prefix = new DatabaseSync(crashPath, { readOnly: true });
  try {
    const rows = prefix
      .prepare("SELECT seq, id FROM events WHERE thread_id=? ORDER BY seq")
      .all(h.id)
      .map((row) => ({ seq: Number(row.seq), id: String(row.id) }));
    expect(rows).toEqual(committed.map(({ seq, id }) => ({ seq, id })));
  } finally {
    prefix.close();
  }
  const errors: unknown[] = [];
  const engine = new Engine(store, {
    registry: h.registry,
    clock: h.clock,
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => engine.close());
  await engine.flush();
  expect(errors).toEqual([]);
  // The turn was still running when the daemon died: it never reads as finished.
  expect(store.getThread(h.id)?.status.state).not.toBe("done");
});
