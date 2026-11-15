import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EarlySubscribe, ServerMessage } from "@ace/protocol";
import { createDevThread } from "../commands.ts";
import { message } from "../payload-test-support.ts";
import { Store } from "../store.ts";
import { subscribe as subscribeXx } from "../subscription.ts";
import { WireEncoder } from "../wire-encoder.ts";
import { NK_LIMITS, NkAdmission } from "./admission.ts";
import { EARLY_REPLAY_BYTES, answerEarly } from "./early-reads.ts";

// What an unconfirmed NK session's subscribes read and send (ADR 0155): only a bounded resume
// is answered, as XX would answer it; everything else costs nothing until confirmation.

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ace-nk-early-")), "events.sqlite"));
  stores.push(store);
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo"));
  const admission = new NkAdmission({ now: () => 0, schedule: () => () => {} });
  const session = admission.admit("phone", () => {});
  if (!session) throw new Error("No session");
  const sent: ServerMessage[] = [];
  const early = (subscribes: EarlySubscribe[]) =>
    answerEarly(subscribes, {
      session,
      store,
      canRead: () => true,
      encoder: new WireEncoder(),
      send: (outgoing) => sent.push(outgoing),
    });
  const append = (id: string, text: string) =>
    store.appendEvents(thread.id, [{ type: "item.created", item: message(id, text) }]);
  return { store, thread, admission, session, sent, early, append };
}

const untouched = {
  bytes: NK_LIMITS.sessionBytes,
  events: NK_LIMITS.sessionEvents,
  output: NK_LIMITS.sessionOutput,
};

it("a resume with a tiny tail on a thread with several MiB missed reads nothing and is held whole", () => {
  const h = setup();
  const cursor = h.store.headSeq();
  for (let n = 0; n < 40; n++) h.append(`big-${n}`, "x".repeat(100 * 1024));
  const subscribe = {
    subscriptionId: "t",
    scope: { kind: "thread" as const, threadId: h.thread.id },
    afterSeq: cursor,
    tail: { items: 1, bytes: 1024 },
  };
  const later = h.early([subscribe]);
  expect(h.sent).toEqual([]);
  expect(h.session.remaining()).toEqual(untouched);
  expect(h.admission.held().bytes).toBe(0);
  expect(later).toEqual([{ type: "subscribe", ...subscribe }]);
});

it("one event larger than the budget is not decoded, and nothing is answered", () => {
  const h = setup();
  const cursor = h.store.headSeq();
  h.append("huge", "y".repeat(EARLY_REPLAY_BYTES * 4));
  expect(
    h.store.bounded.threadEvents(h.thread.id, cursor, h.store.headSeq(), {
      rows: 10,
      bytes: EARLY_REPLAY_BYTES,
    }),
  ).toBeUndefined();
  h.early([
    { subscriptionId: "t", scope: { kind: "thread", threadId: h.thread.id }, afterSeq: cursor },
  ]);
  expect(h.sent).toEqual([]);
});

it("a snapshot (whole status, agents, interactions, queue) and a sidebar window wait for confirmation", () => {
  const h = setup();
  const subscribes: EarlySubscribe[] = [
    { subscriptionId: "open", scope: { kind: "thread", threadId: h.thread.id } },
    { subscriptionId: "w", scope: { kind: "threads", window: { limit: 20 } }, paced: true },
  ];
  expect(h.early(subscribes)).toEqual([
    { type: "subscribe", ...subscribes[0] },
    { type: "subscribe", ...subscribes[1] },
  ]);
  expect(h.sent).toEqual([]);
  expect(h.session.remaining()).toEqual(untouched);
  // No snapshot was built: nothing holds the thread.
  expect(h.store.viewedThreads()).toEqual([]);
});

it("a small resume's missed events go early, marked so, and confirm nothing: the real subscription comes at confirmation", () => {
  const h = setup();
  const cursor = h.store.headSeq();
  h.append("a", "first");
  h.append("b", "second");
  const request = {
    subscriptionId: "t",
    scope: { kind: "thread" as const, threadId: h.thread.id },
    afterSeq: cursor,
    paced: true,
  };
  const later = h.early([request]);
  // The same events XX's replay would carry, flagged early; no progress, no ready.
  const xx: ServerMessage[] = [];
  subscribeXx(
    h.store,
    "t",
    request.scope,
    cursor,
    5000,
    (outgoing) => xx.push(outgoing),
    250,
    () => () => {},
    true,
    new WireEncoder(),
  )();
  const replayed = xx.find((outgoing) => outgoing.type === "events");
  expect(h.sent).toEqual([{ ...replayed, early: true }]);
  expect(h.sent.some((outgoing) => outgoing.type === "subscription.ready")).toBe(false);
  // At confirmation, an ordinary subscribe from where the early events ended, paced as asked.
  expect(later).toEqual([{ type: "subscribe", ...request, afterSeq: h.store.headSeq() }]);
  expect(h.session.remaining().events).toBe(NK_LIMITS.sessionEvents - 2);
});

it("a resume with nothing missed sends nothing early, not even progress", () => {
  const h = setup();
  h.store.appendEvents(h.thread.id, []);
  const request = {
    subscriptionId: "t",
    scope: { kind: "thread" as const, threadId: h.thread.id },
    afterSeq: h.store.headSeq(),
    paced: true,
  };
  expect(h.early([request])).toEqual([{ type: "subscribe", ...request }]);
  expect(h.sent).toEqual([]);
});
