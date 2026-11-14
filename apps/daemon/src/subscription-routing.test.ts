import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ServerMessage, ThreadId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-subscription-routing-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const timers: (() => void)[] = [];
  const schedule = (run: () => void) => {
    timers.push(run);
    return () => {
      const index = timers.indexOf(run);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  const fire = () => {
    for (const run of timers.splice(0)) run();
  };
  let subscriptions = 0;
  const open = (threadId: ThreadId) => {
    const sent: ServerMessage[] = [];
    const stop = subscribe(
      store,
      `s${++subscriptions}`,
      { kind: "thread", threadId },
      store.headSeq(),
      100,
      (m) => sent.push(m),
      250,
      schedule,
    );
    cleanup.push(stop);
    return { sent, stop };
  };
  return {
    store,
    fire,
    open,
    a: createDevThread(store, workspace),
    b: createDevThread(store, workspace),
  };
}
/** The (afterSeq, throughSeq] ranges a client was told about, in order. */
const ranges = (sent: ServerMessage[]) =>
  sent.flatMap((m) =>
    m.type === "events" || m.type === "progress" ? [[m.type, m.afterSeq, m.throughSeq]] : [],
  );

it("each subscription hears only its thread's events and progress over the rest", () => {
  const { store, fire, open, a, b } = setup();
  const start = store.headSeq();
  const onA = open(a.id);
  const onB = open(b.id);
  const alsoA = open(a.id);
  store.appendEvents(a.id, [{ type: "item.created", item: message("a1") }]);
  const afterA = store.headSeq();
  store.appendEvents(b.id, [{ type: "item.created", item: message("b1") }]);
  const afterB = store.headSeq();
  fire();
  for (const subscription of [onA, alsoA]) {
    expect(ranges(subscription.sent)).toEqual([
      ["events", start, afterA],
      ["progress", afterA, afterB],
    ]);
    const events = subscription.sent.find((m) => m.type === "events");
    expect(events?.type === "events" && events.events.map((e) => e.threadId)).toEqual([a.id]);
  }
  // Its own events cover the range a pending progress would have.
  expect(ranges(onB.sent)).toEqual([["events", start, afterB]]);
});

it("a stopped subscription hears nothing more while others on the store still do", () => {
  const { store, fire, open, a, b } = setup();
  const onA = open(a.id);
  const onB = open(b.id);
  onA.stop();
  const before = store.headSeq();
  store.appendEvents(a.id, [{ type: "item.created", item: message("a1") }]);
  store.appendEvents(b.id, [{ type: "item.created", item: message("b1") }]);
  fire();
  expect(onA.sent.filter((m) => m.type === "events" || m.type === "progress")).toEqual([]);
  expect(ranges(onB.sent)).toEqual([["events", before, store.headSeq()]]);
  onB.stop();
  // With every subscription gone a new one still hears the store.
  const again = open(a.id);
  const head = store.headSeq();
  store.appendEvents(a.id, [{ type: "item.created", item: message("a2") }]);
  expect(ranges(again.sent)).toEqual([["events", head, store.headSeq()]]);
});
