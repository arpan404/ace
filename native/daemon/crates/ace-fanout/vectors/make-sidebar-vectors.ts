// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `sidebar.json`, the byte fixtures T3's Rust sidebar subscription is proved against.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-sidebar-vectors.ts
 *
 * Each case drives the TypeScript `subscribe` over a windowed scope with a real `Store` and a
 * real `SidebarPlacement`, recording every sidebar read it asks for (in order, with its
 * result), every place it sends a row with, the device's read cursors, and every
 * `snapshot`/`threads.patch` frame. The Rust test answers the same reads through its
 * `SidebarStore` and `DeviceReads`, places rows from the recorded places, and compares bytes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, ServerMessage, Thread, ThreadId, WorkspaceId } from "@ace/protocol";
import { Thread as ThreadSchema } from "@ace/protocol";
import { isChatEntry } from "../../../../../packages/ui-core/src/chat-list.ts";
import { threadSignal } from "../../../../../packages/ui-core/src/thread-place.ts";
import { SidebarPlacement } from "../../../../../apps/daemon/src/sidebar-placement.ts";
import { Store } from "../../../../../apps/daemon/src/store.ts";
import { pageSubscription, subscribe } from "../../../../../apps/daemon/src/subscription.ts";
import { WireEncoder } from "../../../../../apps/daemon/src/wire-encoder.ts";
import { stable, writeVectors } from "../../../vectors/vectors-io.ts";

const encoder = new WireEncoder();
const json = (value: unknown): string => JSON.stringify(value);

type Place = { place: unknown; signal: unknown };
type Read = { call: string; args: (string | number | null)[]; result: unknown };
type Live = { events: string[]; frames: string[] };
type Case = {
  name: string;
  window: Record<string, unknown>;
  paced: boolean;
  device: boolean;
  epochs: { epoch: string; places: Record<string, Place | null> }[];
  readStates: Record<string, unknown>;
  reads: Read[];
  frames: string[];
  live: Live[];
  page: { cursor: { at: number; id: string }; requestId: string; frames: string[] } | null;
  pageStale: { cursor: { at: number; id: string }; requestId: string; error: string } | null;
  change: { threadId: string; frames: string[] } | null;
};

const DEVICE = "device-1";
const OTHER = "device-2";

/** The pagination tests' window: every unsettled and pinned thread plus 20 settled. */
function seed(store: Store, workspace: WorkspaceId) {
  const entries = Array.from({ length: 55 }, (_, index) =>
    ThreadSchema.parse({
      id: `history-${String(index).padStart(3, "0")}`,
      workspaceId: workspace,
      title: `Task ${index}`,
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 1000 - index,
      activityAt: 1000 - index,
      settledAt: 2000,
      hasSentMessage: true,
    }),
  );
  for (const entry of entries)
    store.appendEvents(entry.id, [{ type: "thread.created", thread: entry }], entry.updatedAt);
  const active = ThreadSchema.parse({
    ...entries[0],
    id: "active",
    status: { state: "working", agents: 1 },
    settledAt: undefined,
  });
  store.appendEvents(active.id, [{ type: "thread.created", thread: active }], 3000);
  const pinned = ThreadSchema.parse({ ...entries[0], id: "pinned", pinned: true });
  store.appendEvents(pinned.id, [{ type: "thread.created", thread: pinned }], 3000);
  return { entries, active, pinned };
}

type Ctx = {
  store: Store;
  workspace: WorkspaceId;
  threads: Thread[];
  sent: string[];
  live: Live[];
  step: (threadId: ThreadId, payloads: Event["payload"][]) => Live;
  append: (threadId: ThreadId, payloads: Event["payload"][]) => void;
  place: SidebarPlacement;
  places: Record<string, Place | null>;
};

async function runSidebar(
  name: string,
  body: (ctx: Ctx) => {
    window: Record<string, unknown>;
    paced?: boolean;
    device?: boolean;
    live?: (ctx: Ctx) => Live[];
    page?: { cursor: { at: number; id: string }; requestId: string };
    pageStale?: { cursor: { at: number; id: string }; requestId: string };
    change?: { threadId: ThreadId };
  },
): Promise<Case> {
  const home = mkdtempSync(join(tmpdir(), "ace-fanout-sidebar-"));
  // One fixed clock: the store stamps appends and read cursors from it, so two runs that land
  // in different milliseconds cannot record different bytes.
  const store = new Store(join(home, "events.sqlite"), undefined, {
    now: () => 1_765_000_000_000,
  });
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const seeded = seed(store, workspace);
  const reads: Read[] = [];
  const readStates: Record<string, unknown> = {};
  const liveBatches: { events: Event[]; head: number }[] = [];
  const live: Live[] = [];
  const sent: string[] = [];
  const places: Record<string, Place | null> = {};
  // Appends carry their own timestamps: a fixture must not depend on the clock's granularity.
  let clock = 10_000;
  const append = (threadId: ThreadId, payloads: Event["payload"][]) => {
    clock += 1;
    store.appendEvents(threadId, payloads as never, clock);
  };
  const send = (server_message: ServerMessage) => sent.push(encoder.encode(server_message));
  const place = new SidebarPlacement("token", () => 1_000);
  const recordingPlacement = {
    get epoch() {
      return place.epoch;
    },
    place(entry: { id: string }) {
      const found = place.place(entry as never);
      const signal = found
        ? threadSignal(entry as never, found.place, found.standing, isChatEntry(entry as never))
        : undefined;
      places[entry.id] = found ? { place: found.place, signal: signal ?? null } : null;
      return found;
    },
    subscribe: (listener: () => void) => place.subscribe(listener),
  };
  const record = (call: string, args: (string | number | null)[], result: unknown) => {
    reads.push({ call, args, result });
    return result;
  };
  const wrapped = {
    sidebarPage: (
      options: Parameters<Store["sidebarPage"]>[0],
      before?: Parameters<Store["sidebarPage"]>[1],
      reuse?: Parameters<Store["sidebarPage"]>[2],
    ) => {
      const page = store.sidebarPage(options, before, reuse);
      record(
        "sidebarPage",
        [
          json({
            limit: options.limit,
            project: options.project ?? null,
            archived: options.archived ?? false,
            withChats: options.withChats ?? false,
          }),
          before ? json(before) : null,
          reuse ? json([...reuse.changed]) : null,
        ],
        json(page),
      );
      return page;
    },
    sidebarRowRevision: (entry: Parameters<Store["sidebarRowRevision"]>[0]) => {
      const revision = store.sidebarRowRevision(entry);
      record("sidebarRowRevision", [entry.id], revision ?? null);
      return revision;
    },
    headSeq: () => record("headSeq", [], store.headSeq()),
    subscribe: (listener: (events: Event[]) => void) => {
      record("subscribe", [], null);
      return store.subscribe((events) => {
        liveBatches.push({ events, head: events.at(-1)?.seq ?? 0 });
        listener(events);
      });
    },
    threadReadState: (threadId: ThreadId, forDevice: string) => {
      const cursor = store.threadReadState(threadId, forDevice as never);
      const reading = { lastSeenSeq: cursor.lastSeenSeq, updatedAt: cursor.updatedAt };
      record("threadReadState", [threadId, forDevice], json(reading));
      readStates[threadId] = reading;
      return cursor;
    },
    onThreadRead: (callback: (threadId: ThreadId, forDevice: string) => void) => {
      record("onThreadRead", [], null);
      return store.onThreadRead(callback);
    },
  };
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
  const context: Ctx = {
    store,
    workspace,
    threads: seeded.entries,
    sent,
    live,
    step,
    append,
    place,
    places,
  };
  const options = body(context);
  const framesBefore = sent.length;
  const stop = subscribe(
    wrapped as never,
    "window",
    { kind: "threads", window: options.window } as never,
    undefined,
    5000,
    send,
    250,
    () => () => {},
    options.paced ?? false,
    encoder,
    recordingPlacement as never,
    undefined,
    options.device ? (DEVICE as never) : undefined,
  );
  const frames = sent.slice(framesBefore);
  live.push(...(options.live?.(context) ?? []));
  let page: Case["page"] = null;
  if (options.page) {
    const before = sent.length;
    pageSubscription(stop, options.page.cursor as never, options.page.requestId);
    page = { ...options.page, frames: sent.slice(before) };
  }
  let pageStale: Case["pageStale"] = null;
  if (options.pageStale) {
    let error = "";
    try {
      pageSubscription(stop, options.pageStale.cursor as never, options.pageStale.requestId);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    pageStale = { ...options.pageStale, error };
  }
  let change: Case["change"] = null;
  if (options.change) {
    const before = sent.length;
    store.markThreadRead(options.change.threadId, DEVICE as never, store.headSeq());
    await new Promise((resolve) => setTimeout(resolve, 0));
    change = { threadId: options.change.threadId, frames: sent.slice(before) };
  }
  const built: Case = {
    name,
    window: options.window,
    paced: options.paced ?? false,
    device: options.device ?? false,
    epochs: [{ epoch: recordingPlacement.epoch, places: structuredClone(places) }],
    readStates,
    reads,
    frames,
    live,
    page,
    pageStale,
    change,
  };
  stop();
  store.close();
  rmSync(home, { recursive: true, force: true });
  return built;
}

const cases: Case[] = [];

cases.push(
  await runSidebar("a window's first open carries every row with its place", () => ({
    window: { limit: 20 },
  })),
);

cases.push(
  await runSidebar("a live change sends only the threads it touched", (ctx) => ({
    window: { limit: 20 },
    live: () => [ctx.step("active" as ThreadId, [{ type: "thread.updated", title: "renamed" }])],
  })),
);

cases.push(
  await runSidebar("a thread that leaves the window is removed without its history", (ctx) => ({
    window: { limit: 20 },
    live: () => [
      ctx.step("history-000" as ThreadId, [{ type: "thread.updated", archivedAt: 5001 }] as never),
    ],
  })),
);

cases.push(
  await runSidebar("a page continues from the window cursor", (ctx) => {
    const first = ctx.store.sidebarPage({ limit: 20, withChats: true });
    const before = first.window.before;
    if (!before) throw new Error("the seeded window has no continuation");
    return {
      window: { limit: 20 },
      page: { cursor: { at: before.at, id: before.id }, requestId: "page-2" },
    };
  }),
);

cases.push(
  await runSidebar("a page from another cursor is stale", (ctx) => {
    const first = ctx.store.sidebarPage({ limit: 20, withChats: true });
    const before = first.window.before;
    if (!before) throw new Error("the seeded window has no continuation");
    return {
      window: { limit: 20 },
      pageStale: {
        cursor: { at: before.at + 1, id: before.id },
        requestId: "page-stale",
      },
    };
  }),
);

cases.push(
  await runSidebar("a resumed window sends only what changed and the cursors it keeps", (ctx) => {
    const first = ctx.store.sidebarPage({ limit: 20, withChats: true });
    const revision = first.window.revision;
    if (revision === undefined) throw new Error("no revision");
    ctx.store.markThreadRead("history-001" as ThreadId, DEVICE as never, ctx.store.headSeq());
    ctx.append("history-002" as ThreadId, [{ type: "thread.updated", title: "changed since" }]);
    return {
      window: {
        limit: 20,
        resume: { epoch: "token:activity:0", revision },
      },
      device: true,
    };
  }),
);

cases.push(
  await runSidebar("each row arrives with this device's read cursor", (ctx) => {
    ctx.store.markThreadRead("history-003" as ThreadId, DEVICE as never, ctx.store.headSeq());
    ctx.store.markThreadRead("history-004" as ThreadId, OTHER as never, ctx.store.headSeq());
    return { window: { limit: 20 }, device: true };
  }),
);

cases.push(
  await runSidebar("a row is sent again when this device marks it read", () => ({
    window: { limit: 20 },
    device: true,
    change: { threadId: "history-005" as ThreadId },
  })),
);

cases.push(
  await runSidebar("a paced window says it is ready with a fresh head", () => ({
    window: { limit: 20 },
    paced: true,
  })),
);

writeVectors(join(import.meta.dir, "sidebar.json"), stable({ cases }));
