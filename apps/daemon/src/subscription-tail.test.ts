import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Agent, AgentId, Interaction, type ServerMessage, type ThreadView } from "@ace/protocol";
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

it("a small tail and its fill hold a full snapshot's items, root lane included, with busy subagents", () => {
  const { store, thread } = setup(100);
  store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: "/repo",
        status: { state: "idle" },
        createdAt: 1,
        background: false,
      }),
    },
  ]);
  // A subagent's long run after the person's transcript: a full snapshot keeps the root share.
  for (let index = 0; index < 300; index++)
    store.appendEvents(thread.id, [
      {
        type: "item.created",
        item: { ...message(`child${index}`), agentId: AgentId.parse("child") },
      },
    ]);
  const full = open(store, thread.id).view;
  const small = open(store, thread.id, { items: 30, bytes: 48 * 1024 }).view;
  expect(full.fill).toBeUndefined();
  const request = small.fill;
  if (request === undefined) throw new Error("No fill request");
  const fill = store.readSnapshotFill(thread.id, request);
  expect(fill.order).toEqual(full.itemOrder);
  // Every item the full snapshot holds is either in the small snapshot or sent with the fill.
  const sent = new Set<string>(fill.items.map((item) => item.id));
  expect(fill.order.filter((id) => !sent.has(id) && !Object.hasOwn(small.items, id))).toEqual([]);
  expect(full.itemOrder.filter((id) => id.startsWith("m"))).toHaveLength(100);
  expect(fill.itemsBefore).toBe(full.itemsBefore);
});
