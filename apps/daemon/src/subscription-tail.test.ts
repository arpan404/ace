import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Interaction, type ServerMessage, type ThreadView } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import type { SnapshotTail } from "./thread-reads.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup(items: number) {
  const home = mkdtempSync(join(tmpdir(), "ace-subscription-tail-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  for (let index = 0; index < items; index++)
    store.appendEvents(thread.id, [
      { type: "item.created", item: message(`m${index}`, `answer ${index} `.repeat(40)) },
    ]);
  store.appendEvents(thread.id, [
    {
      type: "interaction.opened",
      interaction: Interaction.parse({
        id: "approve",
        threadId: thread.id,
        agentId: "root",
        blocking: true,
        request: {
          kind: "question",
          questions: [
            { id: "q0", text: "Which?", options: [], multiSelect: false, allowOther: true },
          ],
        },
        state: "pending",
        createdAt: 1,
      }),
    },
    {
      type: "queue.updated",
      revision: 3,
      paused: true,
      reason: "manual",
      resumeAt: null,
      pendingCount: 2,
    },
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  return { store, thread };
}

let subscriptions = 0;
function open(store: Store, threadId: ThreadView["thread"]["id"], tail?: SnapshotTail) {
  const sent: ServerMessage[] = [];
  const stop = subscribe(
    store,
    `s${++subscriptions}`,
    { kind: "thread", threadId },
    undefined,
    5000,
    (m) => sent.push(m),
    250,
    undefined,
    false,
    undefined,
    undefined,
    tail,
  );
  cleanup.push(stop);
  const snapshot = sent.find((m) => m.type === "snapshot");
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread")
    throw new Error("No thread snapshot");
  return { view: snapshot.view, bytes: Buffer.byteLength(JSON.stringify(snapshot)) };
}

/** What a client holds after paging older items in from the snapshot's cursor. */
function pageIn(store: Store, view: ThreadView): string[] {
  const pages: string[][] = [[...view.itemOrder]];
  const held = new Set(view.itemOrder);
  let before = view.itemsBefore;
  while (typeof before === "number") {
    const page = store.readBoundedItemPage(view.thread.id, before, 50, 1024 * 1024);
    pages.unshift(page.items.map((item) => item.id).filter((id) => !held.has(id)));
    for (const item of page.items) held.add(item.id);
    before = page.itemsBefore;
  }
  return pages.flat();
}

it("a small-tail open carries the whole status and the newest items, and pages give the rest", () => {
  const { store, thread } = setup(120);
  const full = open(store, thread.id);
  const small = open(store, thread.id, { items: 30, bytes: 48 * 1024 });

  expect(small.view.itemOrder).toHaveLength(30);
  expect(small.view.itemOrder).toEqual(full.view.itemOrder.slice(-30));
  expect(small.bytes).toBeLessThan(full.bytes / 3);
  // What the thread shows is complete in the first message.
  expect(small.view.thread.status).toEqual(full.view.thread.status);
  expect(small.view.thread.status).toMatchObject({ state: "needs_you" });
  expect(small.view.interactions).toEqual(full.view.interactions);
  expect(Object.keys(small.view.interactions)).toEqual(["approve"]);
  expect(small.view.queue).toEqual(full.view.queue);
  expect(small.view.queue).toMatchObject({ paused: true, pendingCount: 2 });
  expect(small.view.agents).toEqual(full.view.agents);

  expect(pageIn(store, small.view)).toEqual(pageIn(store, full.view));
  expect(pageIn(store, small.view)).toHaveLength(120);
});

it("a small tail stops at its byte budget before its item count", () => {
  const { store, thread } = setup(60);
  const small = open(store, thread.id, { items: 40, bytes: 8 * 1024 });
  expect(small.view.itemOrder.length).toBeLessThan(40);
  expect(small.view.itemOrder.length).toBeGreaterThan(0);
  expect(small.bytes).toBeLessThan(16 * 1024);
  expect(pageIn(store, small.view)).toHaveLength(60);
});

it("a small tail says it is partial, naming the items it only previewed", () => {
  const screen = { items: 30, bytes: 48 * 1024 };
  // Older items left: partial. The full snapshot never is.
  const many = setup(100);
  expect(open(many.store, many.thread.id, screen).view.partial).toEqual({ previews: [] });
  expect(open(many.store, many.thread.id).view.partial).toBeUndefined();
  // Every item fits, whole: a tail that is the full snapshot is not partial.
  const few = setup(5);
  expect(open(few.store, few.thread.id, screen).view.partial).toBeUndefined();
  // A newest reply past the tail's budget is sent as a preview, and named.
  const long = setup(3);
  long.store.appendEvents(long.thread.id, [
    { type: "item.created", item: message("long", "a long answer line\n".repeat(3300)) },
  ]);
  const view = open(long.store, long.thread.id, screen).view;
  expect(view.itemOrder).toEqual(["long"]);
  expect(view.partial).toEqual({ previews: ["long"] });
});
