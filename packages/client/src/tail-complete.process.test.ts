// A real daemon and client over a socket. A thread opened from a small tail is completed by
// subscribing again with neither a cursor nor a tail; these tests hold that completion back, let
// the thread change meanwhile, fail it, drop it and restart through it, and check the client
// always ends as a client opened with a full snapshot afterwards, never showing a working or
// waiting child as gone or the thread as done.
import { afterEach, expect, test, vi } from "vitest";
import {
  AgentId,
  Interaction,
  ItemId,
  type EventPayload,
  type Item,
  type ThreadId,
} from "@ace/protocol";
import type { Client } from "./client.ts";
import { memory } from "./read-snapshots.fixture.ts";
import { Faults, setup, ready, type Harness } from "./test-support.ts";
import { screenTail } from "./types.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const root = AgentId.parse("complete-root");
const child = AgentId.parse("complete-child");
const reply = (id: string, text: string, agentId: string = root, complete = true): Item => ({
  type: "message",
  id: ItemId.parse(id),
  agentId: AgentId.parse(agentId),
  role: "assistant",
  createdAt: 1,
  complete,
  synthetic: false,
  raw: [],
  parts: [{ type: "text", text }],
});
const created = (item: Item): EventPayload => ({ type: "item.created", item });
const agentCreated = (h: Harness, id: string, parentId: string | null, working = false) => ({
  type: "agent.created" as const,
  agent: {
    id: AgentId.parse(id),
    threadId: h.thread.id,
    parentId: parentId === null ? null : AgentId.parse(parentId),
    origin: parentId === null ? ("root" as const) : ("provider_subagent" as const),
    fidelity: "full" as const,
    native: { provider: "codex" as const },
    cwd: h.directory,
    status: working
      ? { state: "working" as const, activity: "responding" as const }
      : { state: "idle" as const },
    createdAt: 1,
    background: false,
  },
});
const append = (h: Harness, events: EventPayload[]) =>
  h.daemon.store.appendEvents(h.thread.id, events);

/** What a view of the thread shows, read through the public reader. */
function shown(client: Client, threadId: ThreadId) {
  const reader = client.cachedThread(threadId);
  if (!reader) throw new Error("No thread");
  return {
    thread: reader.thread,
    queue: reader.queue,
    itemsBefore: reader.itemsBefore,
    order: reader.order,
    items: reader.order.map((id) => reader.item(id)),
    seqs: reader.order.map((id) => reader.itemSeq?.(id)),
    agents: reader
      .agentIds()
      .toSorted()
      .map((id) => reader.agent(id)),
    interactions: reader.interactionIds().map((id) => reader.interaction(id)),
  };
}

/**
 * A small-tail client whose sends of the completing subscribe (any thread subscribe after its
 * first) wait until `release`. A socket that closes drops what it held, as a real one does.
 */
function gated(h: Harness, options: Parameters<Harness["make"]>[0] = {}) {
  const faults = new Faults(h.daemon.url);
  let subscribes = 0;
  let held: (() => void)[] = [];
  let holding = true;
  const transport = () => {
    const inner = faults.create();
    held = [];
    return {
      ...inner,
      send: (text: string) => {
        const message: unknown = JSON.parse(text);
        const subscribe =
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "subscribe" &&
          "scope" in message &&
          JSON.stringify(message.scope).includes('"thread"');
        if (subscribe && ++subscribes > 1 && holding) held.push(() => inner.send(text));
        else inner.send(text);
      },
    };
  };
  const made = h.make({ openTail: screenTail, transport, ...options });
  return {
    ...made,
    faults,
    held: () => held.length,
    release() {
      holding = false;
      for (const send of held.splice(0)) send();
    },
  };
}

/** The thread as a client that opens it now, with no tail, holds it. */
async function freshlyOpened(h: Harness) {
  const full = h.make();
  await ready(full.client);
  const lease = full.client.thread(h.thread.id);
  await vi.waitFor(() => expect(lease.store.cursor).toBe(h.daemon.store.headSeq()));
  return full.client;
}
async function endsAsFullSnapshot(h: Harness, client: Client) {
  await vi.waitFor(() => expect(client.cachedThread(h.thread.id)?.filling).toBe(false), {
    timeout: 8_000,
  });
  const expected = shown(await freshlyOpened(h), h.thread.id);
  await vi.waitFor(() => expect(shown(client, h.thread.id)).toEqual(expected), { timeout: 8_000 });
}

/** A small deterministic generator: the same seed gives the same thread and changes. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Root and a working child, over 200 settled agents, and a transcript across both lanes. */
function busyThread(h: Harness, next: () => number) {
  // The thread's status as the engine derives it from its tree: the child is working.
  append(h, [
    agentCreated(h, root, null),
    agentCreated(h, child, root, true),
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  append(h, [created(reply("streaming", "", child, false))]);
  for (let index = 0; index < 220; index += 20)
    append(
      h,
      Array.from({ length: 20 }, (_, n) => agentCreated(h, `settled${index + n}`, root)),
    );
  const ids: string[] = [];
  const count = 60 + Math.floor(next() * 120);
  for (let index = 0; index < count; index++) {
    const id = `item${index}`;
    ids.push(id);
    const size = next() < 0.04 ? 60_000 : 200 + Math.floor(next() * 2_000);
    append(h, [created(reply(id, "w ".repeat(size / 2), next() < 0.5 ? root : child))]);
  }
  return ids;
}

/** The child asks the person: the thread needs them. */
const asking = (h: Harness): EventPayload => ({
  type: "interaction.opened",
  interaction: Interaction.parse({
    id: "child-asks",
    threadId: h.thread.id,
    agentId: child,
    blocking: true,
    request: {
      kind: "question",
      questions: [{ id: "q0", text: "Which?", options: [], multiSelect: false, allowOther: true }],
    },
    state: "pending",
    createdAt: 2,
  }),
});

test("over generated threads changing during the completion, the client ends as a full snapshot leaves it", async () => {
  for (let seed = 1; seed <= 5; seed++) {
    const h = await setup();
    try {
      const next = random(seed);
      const ids = busyThread(h, next);
      const tail = gated(h);
      await ready(tail.client);
      const lease = tail.client.thread(h.thread.id);
      await vi.waitFor(() => expect(tail.held()).toBe(1));
      // Painted from the tail and owed the rest: the working child is in the tree, and the
      // thread is not shown done.
      expect(lease.store.filling).toBe(true);
      expect(lease.store.agent(child)?.status.state).toBe("working");
      expect(lease.store.thread?.status.state).not.toBe("done");
      for (let change = 0; change < 25; change++) {
        const roll = next();
        const id = ids[Math.floor(next() * ids.length)] ?? "";
        if (roll < 0.2) {
          ids.push(`new${change}`);
          append(h, [created(reply(`new${change}`, `new ${change}`))]);
        } else if (roll < 0.35)
          append(h, [{ type: "item.updated", item: reply(id, `edited ${change}`) }]);
        else if (roll < 0.45) {
          ids.splice(ids.indexOf(id), 1);
          append(h, [{ type: "item.deleted", itemId: ItemId.parse(id) }]);
        } else if (roll < 0.6) append(h, [created(reply(id, `again ${change}`, child))]);
        else if (roll < 0.8)
          append(h, [
            {
              type: "item.delta",
              itemId: ItemId.parse("streaming"),
              agentId: child,
              field: "text",
              append: `more ${change} `,
            },
          ]);
        else
          append(h, [
            {
              type: "agent.status",
              agentId: child,
              status: { state: "working", activity: change % 2 ? "tool" : "responding" },
            },
          ]);
      }
      // The child turns to the person while the completion is still out.
      append(h, [
        asking(h),
        { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
      ]);
      expect(lease.store.filling).toBe(true);
      expect(lease.store.thread?.status.state).not.toBe("done");
      tail.release();
      await endsAsFullSnapshot(h, tail.client);
      expect(lease.store.agent(child)).toBeDefined();
      expect(lease.store.interaction("child-asks")?.state).toBe("pending");
      expect(lease.store.thread?.status.state).toBe("needs_you");
    } finally {
      await h.cleanup();
    }
  }
}, 60_000);

/** A thread whose newest reply is past the tail's budget, so the tail sends it as a preview. */
function oversized(h: Harness) {
  append(h, [agentCreated(h, root, null)]);
  for (let index = 0; index < 40; index++)
    append(h, [created(reply(`r${index}`, `reply ${index} `.repeat(20)))]);
  const long = "a long answer line\n".repeat(3300);
  append(h, [created(reply("long", long))]);
  return long;
}
const textOf = (item: Item | undefined) =>
  item?.type === "message" && item.parts[0]?.type === "text" ? item.parts[0].text : undefined;

test("a completion that fails stays owed, is tried again, and the oversized reply ends whole", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const long = oversized(h);
  const made = h.make({ openTail: screenTail });
  let snapshots = 0;
  let refused = false;
  made.faults.incoming = (message, text, deliver) => {
    if (message.type === "snapshot" && message.view.kind === "thread" && ++snapshots === 2) {
      refused = true;
      return deliver(
        JSON.stringify({
          type: "error",
          code: "subscribe_failed",
          message: "Unknown thread or invalid cursor",
          subscriptionId: message.subscriptionId,
        }),
      );
    }
    deliver(text);
  };
  await ready(made.client);
  const lease = made.client.thread(h.thread.id);
  await vi.waitFor(() => expect(refused).toBe(true));
  // Refused: still owed, its preview still marked cut, until the retry lands.
  expect(lease.store.filling).toBe(true);
  expect(lease.store.truncated("long")).toBe(true);
  expect(textOf(lease.store.item("long"))?.length).toBeLessThan(long.length);
  made.scheduler.advance(1_000);
  await endsAsFullSnapshot(h, made.client);
  expect(textOf(lease.store.item("long"))).toBe(long);
  expect(lease.store.truncated("long")).toBe(false);
});

test("a completion cut off by the connection completes on the next one", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  oversized(h);
  const tail = gated(h);
  await ready(tail.client);
  tail.client.thread(h.thread.id);
  await vi.waitFor(() => expect(tail.held()).toBe(1));
  // The completing subscribe never left: the socket closes under it.
  tail.faults.disconnect();
  append(h, [created(reply("while-away", "written while the socket was down"))]);
  expect(tail.client.cachedThread(h.thread.id)?.filling).toBe(true);
  tail.scheduler.advance(1_000);
  // The next connection subscribes it again, still with neither cursor nor tail.
  await vi.waitFor(() => expect(tail.held()).toBe(1));
  tail.release();
  await endsAsFullSnapshot(h, tail.client);
});

test("a client closed while a thread holds only its tail restores it as owed and completes it", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const long = oversized(h);
  const kept = memory().storage;
  const first = gated(h, { readSnapshots: kept });
  await ready(first.client);
  first.client.thread(h.thread.id);
  await vi.waitFor(() => expect(first.held()).toBe(1));
  await first.client.close();
  append(h, [created(reply("after-close", "written while the app was closed"))]);
  // The same database: the restored copy must not resume from its cursor.
  const second = h.make({ openTail: screenTail, readSnapshots: kept });
  await ready(second.client);
  const lease = second.client.thread(h.thread.id);
  await endsAsFullSnapshot(h, second.client);
  expect(textOf(lease.store.item("long"))).toBe(long);
  const subscribes = second.faults.sent
    .map((text) => JSON.parse(text) as { type: string; afterSeq?: unknown; tail?: unknown })
    .filter((sent) => sent.type === "subscribe" && JSON.stringify(sent).includes('"thread"'));
  expect(subscribes.length).toBeGreaterThan(0);
  for (const sent of subscribes) {
    expect(sent).not.toHaveProperty("afterSeq");
    expect(sent).not.toHaveProperty("tail");
  }
});
