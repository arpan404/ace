import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-subscription-snapshot-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return { store, a: createDevThread(store, workspace), b: createDevThread(store, workspace) };
}
let subscriptions = 0;
function open(store: Store, threadId: ReturnType<typeof createDevThread>["id"]) {
  const sent: ServerMessage[] = [];
  const stop = subscribe(
    store,
    `s${++subscriptions}`,
    { kind: "thread", threadId },
    undefined,
    100,
    (m) => sent.push(m),
  );
  cleanup.push(stop);
  const snapshot = sent.find((m) => m.type === "snapshot");
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return snapshot;
}

it("each subscriber's snapshot of an unchanged thread carries the current head", () => {
  const { store, a, b } = setup();
  store.appendEvents(b.id, [{ type: "item.created", item: message("b") }]);
  const first = open(store, b.id);
  store.appendEvents(a.id, [{ type: "item.created", item: message("a") }]);
  const second = open(store, b.id);
  expect(first.seq).toBeLessThan(second.seq);
  expect(second.seq).toBe(store.headSeq());
  expect(second.view.seq).toBe(second.seq);
  expect(first.view.seq).toBe(first.seq);
  if (second.view.kind !== "thread") throw new Error("Not a thread view");
  expect(second.view.itemOrder).toEqual(["b"]);
});

it("a subscriber's snapshot shows the thread's newest write", () => {
  const { store, b } = setup();
  open(store, b.id);
  store.appendEvents(b.id, [{ type: "item.created", item: message("later") }]);
  const view = open(store, b.id).view;
  if (view.kind !== "thread") throw new Error("Not a thread view");
  expect(view.itemOrder).toEqual(["later"]);
});
