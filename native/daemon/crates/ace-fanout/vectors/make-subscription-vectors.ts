// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `subscription.json`, the byte fixtures T3's Rust subscription is proved against.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-subscription-vectors.ts
 *
 * Each case drives the TypeScript `subscribe` (`apps/daemon/src/subscription.ts`) over a real
 * `Store`, records every store read it asks for (in order, with its result) and every message
 * it sends, framed by `WireEncoder`. The Rust test answers the same reads in the recorded order
 * through its `SubscriptionStore`, feeds the same live batches, fires the same progress timer
 * and compares the bytes. A changed read order, cursor, frame split or bound fails there.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Thread as ThreadSchema } from "@ace/protocol";
import type { Event, ServerMessage, ThreadId } from "@ace/protocol";
import { createThreadListView } from "../../../../../packages/projection/src/index.ts";
import { message } from "../../../../../apps/daemon/src/payload-test-support.ts";
import { Store } from "../../../../../apps/daemon/src/store.ts";
import { subscribe } from "../../../../../apps/daemon/src/subscription.ts";
import type { SnapshotTail } from "../../../../../apps/daemon/src/thread-reads.ts";
import { WireEncoder } from "../../../../../apps/daemon/src/wire-encoder.ts";
import { stable, writeVectors } from "../../../vectors/vectors-io.ts";

const encoder = new WireEncoder();

type Read = { call: string; args: (string | number | null)[]; result: unknown };
type Live = { events: string[]; head: number; frames: string[] };
type Case = {
  name: string;
  scope: { kind: "thread"; threadId: string } | { kind: "threads" };
  afterSeq: number | null;
  replayLimit: number;
  paced: boolean;
  tail: SnapshotTail | null;
  reads: Read[];
  frames: string[];
  live: Live[];
  progress: string[] | null;
  stopAfter: boolean;
  stopBefore: boolean;
};

const json = (value: unknown): string => JSON.stringify(value);

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-fanout-vectors-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  // Explicit threads and timestamps: the fixture must be reproducible, so nothing here reads
  // the clock or a random id.
  const thread = (id: string, at: number) =>
    ThreadSchema.parse({
      id,
      workspaceId: workspace,
      title: id,
      provider: "codex",
      status: { state: "working", agents: 1 },
      createdAt: at,
      updatedAt: at,
      hasSentMessage: true,
    });
  const a = thread("thread-a", 2);
  const b = thread("thread-b", 1);
  store.appendEvents(a.id, [{ type: "thread.created", thread: a }], 2);
  store.appendEvents(b.id, [{ type: "thread.created", thread: b }], 1);
  return { home, store, a, b };
}

type Harness = ReturnType<typeof harness>;

function harness(name: string) {
  const { home, store, a, b } = setup();
  const reads: Read[] = [];
  const liveBatches: { events: Event[]; head: number }[] = [];
  const timers: (() => void)[] = [];
  // Every append gets its own timestamp: a fixture must not depend on the clock's granularity.
  let clock = 10_000;
  const sent: string[] = [];
  const record = (call: string, args: (string | number | null)[], result: unknown) => {
    reads.push({ call, args, result });
    return result;
  };
  const wrapped = {
    headSeq: () => record("headSeq", [], store.headSeq()),
    replaySafe: (after: number) => record("replaySafe", [after], store.replaySafe(after)),
    getThread: (id: ThreadId) => record("getThread", [id], store.getThread(id) !== undefined),
    acquireThread: (id: ThreadId) => {
      record("acquireThread", [id], null);
      store.acquireThread(id);
    },
    releaseThread: (id: ThreadId) => {
      record("releaseThread", [id], null);
      store.releaseThread(id);
    },
    snapshotThread: (id: ThreadId, tail?: SnapshotTail) => {
      const view = store.snapshotThread(id, tail);
      record("snapshotThread", [id, tail ? json(tail) : null], json(view));
      return view;
    },
    listThreads: () => {
      const threads = store.listThreads();
      record("listThreads", [], json(createThreadListView(threads)));
      return threads;
    },
    countThreadEvents: (id: ThreadId, after: number, through: number, limit: number) =>
      record(
        "countThreadEvents",
        [id, after, through, limit],
        store.countThreadEvents(id, after, through, limit),
      ),
    readEvents: (options: {
      afterSeq: number;
      threadId?: ThreadId;
      limit: number;
      byteLimit?: number;
    }) => {
      const events = store.readEvents(options);
      record(
        "readEvents",
        [options.afterSeq, options.limit, options.byteLimit ?? null, options.threadId ?? null],
        events.map((event) => json(event)),
      );
      return events;
    },
    subscribe: (listener: (events: Event[]) => void) => {
      record("subscribe", [], null);
      return store.subscribe((events) => {
        liveBatches.push({ events, head: events.at(-1)?.seq ?? 0 });
        listener(events);
      });
    },
  };
  const append = (threadId: ThreadId, payloads: Event["payload"][]) => {
    clock += 1;
    store.appendEvents(threadId, payloads as never, clock);
  };
  const send = (sent_message: ServerMessage) => sent.push(encoder.encode(sent_message));
  const schedule = (later: () => void) => {
    timers.push(later);
    return () => {
      const index = timers.indexOf(later);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  /** Append to the store, which publishes; the frames the subscription sent are the delta. */
  const step = (threadId: ThreadId, payloads: Event["payload"][]): Live => {
    const before = sent.length;
    append(threadId, payloads);
    const batch = liveBatches.at(-1);
    if (!batch) throw new Error(`${name}: an append published no batch`);
    return {
      events: batch.events.map((event) => json(event)),
      head: batch.head,
      frames: sent.slice(before),
    };
  };
  /** An append nobody hears (a stopped subscription): the batch is read back for the fixture. */
  const stepSilent = (threadId: ThreadId, payloads: Event["payload"][]): Live => {
    const before = sent.length;
    const head = store.headSeq();
    append(threadId, payloads);
    const events = store.readEvents({ afterSeq: head, limit: 100 });
    return {
      events: events.map((event) => json(event)),
      head: events.at(-1)?.seq ?? head,
      frames: sent.slice(before),
    };
  };
  const fire = (): string[] => {
    const before = sent.length;
    for (const later of timers.splice(0)) later();
    return sent.slice(before);
  };
  return {
    name,
    store,
    a,
    b,
    reads,
    sent,
    wrapped,
    send,
    schedule,
    step,
    stepSilent,
    append,
    fire,
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Run one case: subscribe, then the scripted live steps, then (optionally) stop. */
function run(
  name: string,
  build: (bench: Harness) => {
    scope: Case["scope"];
    afterSeq: number | null;
    replayLimit?: number;
    paced?: boolean;
    tail?: SnapshotTail;
    live?: (bench: Harness) => Live[];
    progress?: (bench: Harness) => string[] | null;
    stopAfter?: boolean;
    stopBefore?: boolean;
  },
): Case {
  const h = harness(name);
  const options = build(h);
  const framesBefore = h.sent.length;
  const stop = subscribe(
    h.wrapped as never,
    "s",
    options.scope as never,
    options.afterSeq === null ? undefined : options.afterSeq,
    options.replayLimit ?? 5000,
    h.send,
    250,
    h.schedule,
    options.paced ?? false,
    encoder,
    undefined,
    options.tail,
  );
  if (options.stopBefore) stop();
  const frames = h.sent.slice(framesBefore);
  const live = options.live?.(h) ?? [];
  const progress = options.progress?.(h) ?? null;
  if (options.stopAfter && !options.stopBefore) stop();
  const built: Case = {
    name,
    scope: options.scope,
    afterSeq: options.afterSeq,
    replayLimit: options.replayLimit ?? 5000,
    paced: options.paced ?? false,
    tail: options.tail ?? null,
    reads: h.reads,
    frames,
    live,
    progress,
    stopAfter: options.stopAfter ?? false,
    stopBefore: options.stopBefore ?? false,
  };
  h.close();
  return built;
}

const cases: Case[] = [];

cases.push(
  run("a first open of a thread is its snapshot", (bench) => ({
    scope: { kind: "thread", threadId: bench.a.id },
    afterSeq: null,
  })),
);

cases.push(
  run("a first open carries the tail it was asked for", (bench) => ({
    scope: { kind: "thread", threadId: bench.a.id },
    afterSeq: null,
    tail: { items: 2, bytes: 48 * 1024 },
  })),
);

cases.push(
  run("a first open of the list is its snapshot", () => ({
    scope: { kind: "threads" },
    afterSeq: null,
  })),
);

cases.push(
  run("a list resumes inside the limit with a replay", (bench) => {
    const afterSeq = bench.store.headSeq();
    bench.append(bench.a.id, [
      { type: "thread.updated", title: "one" },
      { type: "thread.updated", title: "two" },
    ]);
    return { scope: { kind: "threads" }, afterSeq };
  }),
);

cases.push(
  run("a thread resumes with only its own events", (bench) => {
    const afterSeq = bench.store.headSeq();
    bench.append(bench.a.id, [{ type: "item.created", item: message("a1") }]);
    bench.append(bench.b.id, [{ type: "item.created", item: message("b1") }]);
    bench.append(bench.a.id, [{ type: "item.updated", item: message("a1") }]);
    return { scope: { kind: "thread", threadId: bench.a.id }, afterSeq, replayLimit: 100 };
  }),
);

cases.push(
  run("a thread whose missed events pass the limit gets a snapshot", (bench) => {
    const afterSeq = bench.store.headSeq();
    for (let index = 0; index < 4; index++)
      bench.append(bench.a.id, [{ type: "item.created", item: message(`a${index}`) }]);
    for (let index = 0; index < 6; index++)
      bench.append(bench.b.id, [{ type: "item.created", item: message(`b${index}`) }]);
    return { scope: { kind: "thread", threadId: bench.a.id }, afterSeq, replayLimit: 2 };
  }),
);

cases.push(
  run("a list cursor further behind than the limit gets a snapshot", (bench) => {
    const afterSeq = bench.store.headSeq();
    for (let index = 0; index < 4; index++)
      bench.append(bench.a.id, [{ type: "thread.updated", title: `t${index}` }]);
    return { scope: { kind: "threads" }, afterSeq, replayLimit: 2 };
  }),
);

cases.push(
  run("a resume after a long streamed turn costs no more than a snapshot", (bench) => {
    bench.append(bench.a.id, [{ type: "item.created", item: message("reply") }]);
    const afterSeq = bench.store.headSeq();
    for (let index = 0; index < 700; index++)
      bench.append(bench.a.id, [
        {
          type: "item.delta",
          itemId: "reply" as never,
          agentId: "a" as never,
          field: "text",
          append: `line ${index} of a streamed answer\n`,
        },
      ]);
    return { scope: { kind: "thread", threadId: bench.a.id }, afterSeq, replayLimit: 5000 };
  }),
);

cases.push(
  run("a short resume still replays its events", (bench) => {
    const afterSeq = bench.store.headSeq();
    bench.append(bench.a.id, [
      { type: "item.created", item: message("one") },
      {
        type: "item.delta",
        itemId: "one" as never,
        agentId: "a" as never,
        field: "text",
        append: "x",
      },
    ]);
    return { scope: { kind: "thread", threadId: bench.a.id }, afterSeq };
  }),
);

cases.push(
  run("a paced subscription says it is ready", (bench) => ({
    scope: { kind: "thread", threadId: bench.a.id },
    afterSeq: null,
    paced: true,
  })),
);

cases.push(
  run("a subscription hears its thread's events and progress over the rest", (bench) => ({
    scope: { kind: "thread", threadId: bench.a.id },
    afterSeq: bench.store.headSeq(),
    live: (steps) => {
      const first = steps.step(steps.a.id, [{ type: "item.created", item: message("a1") }]);
      const second = steps.step(steps.b.id, [{ type: "item.created", item: message("b1") }]);
      return [first, second];
    },
    progress: (clock) => clock.fire(),
  })),
);

cases.push(
  run("a list subscription reports a filtered batch through progress", (bench) => ({
    scope: { kind: "threads" },
    afterSeq: bench.store.headSeq(),
    live: (steps) => [
      steps.step(steps.a.id, [
        {
          type: "item.delta",
          itemId: "reply" as never,
          agentId: "a" as never,
          field: "text",
          append: "not a sidebar event",
        },
      ]),
    ],
    progress: (clock) => clock.fire(),
  })),
);

cases.push(
  run("a stopped subscription hears nothing more", (bench) => ({
    scope: { kind: "thread", threadId: bench.a.id },
    afterSeq: bench.store.headSeq(),
    live: (steps) => [
      steps.stepSilent(steps.a.id, [{ type: "item.created", item: message("late") }]),
    ],
    progress: () => null,
    stopBefore: true,
  })),
);

writeVectors(join(import.meta.dir, "subscription.json"), stable({ cases }));
