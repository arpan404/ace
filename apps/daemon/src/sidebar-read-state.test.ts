import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceId, type ServerMessage, type ThreadListView } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

const phone = DeviceId.parse("phone");
const laptop = DeviceId.parse("laptop");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-sidebar-read-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const threads = [createDevThread(store, workspace), createDevThread(store, workspace)];
  for (const [index, thread] of threads.entries())
    store.appendEvents(thread.id, [{ type: "item.created", item: message(`m${index}`) }]);
  return { store, threads };
}

function list(
  store: Store,
  device: DeviceId | undefined,
  resume?: { revision: number; epoch: string },
) {
  const sent: ServerMessage[] = [];
  const stop = subscribe(
    store,
    "list",
    { kind: "threads", window: { limit: 20, ...(resume ? { resume } : {}) } },
    undefined,
    5000,
    (m) => sent.push(m),
    250,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    device,
  );
  cleanup.push(stop);
  const snapshot = sent[0];
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
    throw new Error("No list snapshot");
  return { sent, view: snapshot.view };
}
const cursorOf = (view: ThreadListView, id: string) =>
  Object.hasOwn(view.threads, id) ? view.threads[id]?.readState : undefined;

it("each row arrives with this device's read cursor", () => {
  const { store, threads } = setup();
  const [read, unread] = threads;
  if (!read || !unread) throw new Error("No threads");
  store.markThreadRead(read.id, phone, store.headSeq());
  store.markThreadRead(unread.id, laptop, store.headSeq());
  const { view } = list(store, phone);
  expect(cursorOf(view, read.id)).toEqual(
    expect.objectContaining({ lastSeenSeq: store.headSeq(), updatedAt: expect.any(Number) }),
  );
  // Another device's mark is not this device's.
  expect(cursorOf(view, unread.id)).toEqual({ lastSeenSeq: 0, updatedAt: null });
});

it("a row is sent again when this device marks it read, and not for another device", async () => {
  const { store, threads } = setup();
  const [thread] = threads;
  if (!thread) throw new Error("No thread");
  const { sent } = list(store, phone);
  store.markThreadRead(thread.id, laptop, store.headSeq());
  await Promise.resolve();
  expect(sent.filter((m) => m.type === "threads.patch")).toHaveLength(0);
  const head = store.headSeq();
  store.markThreadRead(thread.id, phone, head);
  await Promise.resolve();
  const patch = sent.find((m) => m.type === "threads.patch");
  if (patch?.type !== "threads.patch") throw new Error("No patch");
  expect(Object.keys(patch.threads)).toEqual([thread.id]);
  expect(patch.threads[thread.id]?.readState?.lastSeenSeq).toBe(head);
});

it("a resumed list sends the cursors of the rows it keeps", () => {
  const { store, threads } = setup();
  const [thread] = threads;
  if (!thread) throw new Error("No thread");
  const first = list(store, phone).view;
  const window = first.window;
  if (window?.revision === undefined) throw new Error("No revision");
  store.markThreadRead(thread.id, phone, store.headSeq());
  const resumed = list(store, phone, { revision: window.revision, epoch: window.epoch ?? "" }).view;
  expect(resumed.keep).toContain(thread.id);
  expect(resumed.reads?.[thread.id]?.lastSeenSeq).toBe(store.headSeq());
});

it("a list for no known device carries no read cursors", () => {
  const { store, threads } = setup();
  const { view } = list(store, undefined);
  for (const thread of threads) expect(cursorOf(view, thread.id)).toBeUndefined();
});
