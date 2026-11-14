// A real daemon and client: the small first snapshot, the background pages behind it and the
// resume that may answer with a snapshot all cross the socket, so only the wiring proves that the
// client ends where a full snapshot would leave it.
import { afterEach, expect, test } from "vitest";
import {
  AgentId,
  Interaction,
  ItemId,
  type EventPayload,
  type ServerMessage,
  type ThreadId,
} from "@ace/protocol";
import type { Client } from "./client.ts";
import { Faults, setup, ready, when, type Harness } from "./test-support.ts";
import { screenTail } from "./types.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const root = AgentId.parse("tail-root");
const replyItem = (id: string, text: string, complete = true) => ({
  type: "message" as const,
  id: ItemId.parse(id),
  agentId: root,
  role: "assistant" as const,
  createdAt: 1,
  complete,
  synthetic: false,
  raw: [],
  parts: [{ type: "text" as const, text }],
});
const reply = (id: string, text: string, complete = true): EventPayload => ({
  type: "item.created",
  item: replyItem(id, text, complete),
});
function fill(h: Harness, items: number) {
  const threadId = h.thread.id;
  h.daemon.store.appendEvents(threadId, [
    {
      type: "agent.created",
      agent: {
        id: root,
        threadId,
        parentId: null,
        origin: "root",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: h.directory,
        status: { state: "idle" },
        createdAt: 1,
        background: false,
      },
    },
  ]);
  for (let index = 0; index < items; index++)
    h.daemon.store.appendEvents(threadId, [reply(`r${index}`, `reply ${index} `.repeat(60))]);
  h.daemon.store.appendEvents(threadId, [
    {
      type: "interaction.opened",
      interaction: Interaction.parse({
        id: "approve",
        threadId,
        agentId: root,
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
      revision: 4,
      paused: true,
      reason: "manual",
      resumeAt: null,
      pendingCount: 2,
    },
  ]);
}

/** What a view of the thread shows, read through the public reader. */
function shown(client: Client, threadId: ThreadId) {
  const reader = client.cachedThread(threadId);
  if (!reader) throw new Error("No thread");
  const view = {
    thread: reader.thread,
    queue: reader.queue,
    itemsBefore: reader.itemsBefore,
    order: reader.order,
    items: reader.order.map((id) => reader.item(id)),
    seqs: reader.order.map((id) => reader.itemSeq?.(id)),
    agents: reader.agentIds().map((id) => reader.agent(id)),
    runs: reader.runIds?.().map((id) => reader.run(id)),
    interactions: reader.interactionIds().map((id) => reader.interaction(id)),
    tasks: reader.taskIds().map((id) => reader.task(id)),
  };
  // A paged text item also names where its full text is read from (`source`); its text, the
  // part a view shows, is the snapshot's. Only that descriptor is set aside.
  return JSON.parse(
    JSON.stringify(view, (key, value: unknown) => (key === "source" ? undefined : value)),
  ) as unknown;
}
const snapshotOf = (wire: ServerMessage) =>
  wire.type === "snapshot" && wire.view.kind === "thread" ? wire : undefined;

/** A transport whose daemon predates `tail`: the field never reaches it. */
function olderDaemon(h: Harness) {
  const faults = new Faults(h.daemon.url);
  const transport = () => {
    const inner = faults.create();
    return {
      ...inner,
      send: (text: string) => {
        const message: unknown = JSON.parse(text);
        if (typeof message === "object" && message !== null && "tail" in message)
          delete (message as { tail?: unknown }).tail;
        inner.send(JSON.stringify(message));
      },
    };
  };
  return { faults, transport };
}

async function open(client: Client, threadId: ThreadId, items: number) {
  await ready(client);
  const lease = client.thread(threadId);
  await when(
    lease.store.select(["order", "history"], (reader) => [reader.order.length, reader.itemsBefore]),
    ([length, before]) => length === items && before === null,
  );
  return lease;
}

test("a thread opened from a small tail pages in to what a full snapshot shows", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  fill(h, 120);
  const full = h.make();
  const tail = h.make({ openTail: screenTail });
  await open(full.client, h.thread.id, 120);
  await open(tail.client, h.thread.id, 120);

  const first = snapshotOf(await tail.faults.wait((wire) => !!snapshotOf(wire)));
  const whole = snapshotOf(await full.faults.wait((wire) => !!snapshotOf(wire)));
  if (!first || !whole || first.view.kind !== "thread" || whole.view.kind !== "thread")
    throw new Error("No snapshot");
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(screenTail.bytes + 8192);
  expect(first.view.itemOrder.length).toBeLessThanOrEqual(screenTail.items);
  // Approvals, queue and status are whole in the first message.
  expect(first.view.interactions).toEqual(whole.view.interactions);
  expect(first.view.queue).toEqual(whole.view.queue);
  expect(first.view.thread).toEqual(whole.view.thread);
  expect(first.view.agents).toEqual(whole.view.agents);

  expect(shown(tail.client, h.thread.id)).toEqual(shown(full.client, h.thread.id));
});

test("a client asking for a small tail still opens a daemon that sends the full snapshot", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  fill(h, 60);
  const reference = h.make();
  const older = olderDaemon(h);
  const client = h.make({ openTail: screenTail, transport: older.transport }).client;
  await open(reference.client, h.thread.id, 60);
  await open(client, h.thread.id, 60);
  expect(older.faults.sent.some((text) => text.includes('"items.page"'))).toBe(false);
  expect(shown(client, h.thread.id)).toEqual(shown(reference.client, h.thread.id));
});

test("a resume after a long streamed turn ends where a fresh open does", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  fill(h, 40);
  const { client, faults, scheduler } = h.make({ openTail: screenTail });
  const lease = await open(client, h.thread.id, 40);
  const opened = faults.sent.length;
  faults.disconnect();
  h.daemon.store.appendEvents(h.thread.id, [reply("long", "", false)]);
  for (let batch = 0; batch < 60; batch++)
    h.daemon.store.appendEvents(
      h.thread.id,
      Array.from({ length: 50 }, () => ({
        type: "item.delta" as const,
        itemId: ItemId.parse("long"),
        agentId: root,
        field: "text" as const,
        append: "streamed words ",
      })),
    );
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.updated", item: replyItem("long", "streamed words ".repeat(3000)) },
  ]);
  scheduler.advance(250);
  await when(client.connectionState(), (state) => state === "ready");
  await when(
    lease.store.select(["cursor", "sync"], (reader) => [reader.cursor, reader.syncing]),
    ([cursor, syncing]) => cursor === h.daemon.store.headSeq() && !syncing,
  );
  expect(faults.sent.slice(opened).some((text) => text.includes('"afterSeq"'))).toBe(true);

  const fresh = h.make();
  await open(fresh.client, h.thread.id, 41);
  await when(
    lease.store.select(["order"], (reader) => reader.order.length),
    (length) => length === 41,
  );
  expect(shown(client, h.thread.id)).toEqual(shown(fresh.client, h.thread.id));
});
