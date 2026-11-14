// A real daemon and client over a socket: the fill of a small-tail open is answered while the
// thread keeps changing, fails, or comes back stale, and the client must still end where a full
// snapshot taken after all of it leaves a client.
import { afterEach, expect, test, vi } from "vitest";
import {
  AgentId,
  ItemId,
  type EventPayload,
  type Item,
  type ServerMessage,
  type ThreadId,
} from "@ace/protocol";
import type { Client } from "./client.ts";
import { setup, ready, type Harness } from "./test-support.ts";
import { screenTail } from "./types.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const root = AgentId.parse("fill-root");
const reply = (id: string, text: string, agentId: string = root, complete = true): Item => ({
  type: "message",
  id: ItemId.parse(id),
  agentId: AgentId.parse(agentId),
  role: id.startsWith("input:") ? "user" : "assistant",
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

/** A small-tail client whose `items.fill` answers are held until the test lets them through. */
async function holdingFills(h: Harness, rewrite?: (answer: ServerMessage) => ServerMessage) {
  const made = h.make({ openTail: screenTail });
  const held: (() => void)[] = [];
  made.faults.incoming = (message, text, deliver) => {
    if (message.type !== "items.fill") return deliver(text);
    held.push(() => deliver(rewrite ? JSON.stringify(rewrite(message)) : text));
  };
  await ready(made.client);
  const lease = made.client.thread(h.thread.id);
  const nextAnswer = async () => {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 5_000 });
    return held.shift() ?? (() => {});
  };
  return { ...made, lease, nextAnswer };
}

/** The thread as a client that opens it now, with no tail, holds it. */
async function freshlyOpened(h: Harness) {
  const full = h.make();
  await ready(full.client);
  const lease = full.client.thread(h.thread.id);
  await vi.waitFor(() => expect(lease.store.cursor).toBe(h.daemon.store.headSeq()));
  return full.client;
}

async function settlesLike(h: Harness, client: Client) {
  const expected = shown(await freshlyOpened(h), h.thread.id);
  await vi.waitFor(() => expect(shown(client, h.thread.id)).toEqual(expected), { timeout: 8_000 });
  expect(client.cachedThread(h.thread.id)?.filling).toBe(false);
}

test("a repeated create and an admitted input arriving while the fill is out: the live copy wins", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  append(h, [agentCreated(h, root, null)]);
  append(h, [created(reply("input:cmd-1", "the person's old prompt"))]);
  for (let index = 0; index < 60; index++)
    append(h, [created(reply(`r${index}`, `reply ${index} `.repeat(30)))]);
  const tail = await holdingFills(h);
  const answer = await tail.nextAnswer();
  // Read on the daemon already; these land before the answer does.
  append(h, [created(reply("r3", "rewritten after the fill was read"))]);
  // As the engine admits an input: the event, and the update that records its native id.
  append(h, [
    { type: "input.admitted", agentId: root, nativeInputId: "native-1", commandId: "cmd-1" },
    {
      type: "item.updated",
      item: { ...reply("input:cmd-1", "the person's old prompt"), nativeId: "native-1" },
    },
  ]);
  await vi.waitFor(() => expect(tail.lease.store.cursor).toBe(h.daemon.store.headSeq()));
  answer();
  await settlesLike(h, tail.client);
  const store = tail.client.cachedThread(h.thread.id);
  expect(store?.item("r3")).toMatchObject({
    parts: [{ text: "rewritten after the fill was read" }],
  });
  expect(store?.item("input:cmd-1")).toMatchObject({ nativeId: "native-1" });
});

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

test("over generated threads changing while the fill is out, the client ends as a full snapshot leaves it", async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const h = await setup();
    try {
      const next = random(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
      append(h, [agentCreated(h, root, null), agentCreated(h, "child", root, true)]);
      append(h, [created(reply("streaming", "", "child", false))]);
      const ids: string[] = [];
      for (let index = 0; index < 60 + Math.floor(next() * 120); index++) {
        const id = `s${seed}-${index}`;
        ids.push(id);
        const size = next() < 0.04 ? 60_000 : 200 + Math.floor(next() * 2_000);
        append(h, [created(reply(id, "w ".repeat(size / 2), next() < 0.5 ? root : "child"))]);
      }
      const tail = await holdingFills(h);
      const answer = await tail.nextAnswer();
      // While the answer is out: new items, edits, deletes, repeated creates, a working child.
      for (let change = 0; change < 25; change++) {
        const roll = next();
        const id = pick(ids) ?? "";
        if (roll < 0.2) {
          const fresh = `s${seed}-new${change}`;
          ids.push(fresh);
          append(h, [created(reply(fresh, `new ${change}`))]);
        } else if (roll < 0.35)
          append(h, [{ type: "item.updated", item: reply(id, `edited ${change}`) }]);
        else if (roll < 0.45) {
          ids.splice(ids.indexOf(id), 1);
          append(h, [{ type: "item.deleted", itemId: ItemId.parse(id) }]);
        } else if (roll < 0.6) append(h, [created(reply(id, `again ${change}`, "child"))]);
        else if (roll < 0.8)
          append(h, [
            {
              type: "item.delta",
              itemId: ItemId.parse("streaming"),
              agentId: AgentId.parse("child"),
              field: "text",
              append: `more ${change} `,
            },
          ]);
        else
          append(h, [
            {
              type: "agent.status",
              agentId: AgentId.parse("child"),
              status:
                change % 2
                  ? { state: "working", activity: "tool" }
                  : { state: "working", activity: "responding" },
            },
          ]);
      }
      await vi.waitFor(() => expect(tail.lease.store.cursor).toBe(h.daemon.store.headSeq()));
      answer();
      await settlesLike(h, tail.client);
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

test("a fill that fails stays owed, is tried again, and the oversized reply ends whole", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const long = oversized(h);
  let failures = 1;
  const made = h.make({ openTail: screenTail });
  made.faults.incoming = (message, text, deliver) => {
    if (message.type === "items.fill" && failures-- > 0)
      return deliver(
        JSON.stringify({
          type: "error",
          code: "read_denied",
          message: "x",
          requestId: message.requestId,
        }),
      );
    deliver(text);
  };
  await ready(made.client);
  const lease = made.client.thread(h.thread.id);
  await vi.waitFor(() =>
    expect(made.faults.sent.some((t) => t.includes('"items.fill"'))).toBe(true),
  );
  await vi.waitFor(() => expect(failures).toBe(0));
  // Failed: still owed, its preview still marked cut, until the retry lands.
  expect(lease.store.filling).toBe(true);
  expect(lease.store.truncated("long")).toBe(true);
  made.scheduler.advance(1_000);
  await vi.waitFor(() => expect(lease.store.filling).toBe(false));
  const item = lease.store.item("long");
  expect(item?.type === "message" ? item.parts[0] : undefined).toMatchObject({ text: long });
  expect(lease.store.truncated("long")).toBe(false);
});

test("three stale fill answers fall back to the full snapshot", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  oversized(h);
  const made = h.make({ openTail: screenTail });
  let answers = 0;
  made.faults.incoming = (message, text, deliver) => {
    if (message.type !== "items.fill") return deliver(text);
    answers++;
    // Names an item neither held nor sent: an answer the client cannot use.
    deliver(JSON.stringify({ ...message, order: [...message.order, "missing"] }));
  };
  await ready(made.client);
  made.client.thread(h.thread.id);
  for (let attempt = 1; attempt < 3; attempt++) {
    await vi.waitFor(() => expect(answers).toBe(attempt));
    made.scheduler.advance(10_000);
  }
  await settlesLike(h, made.client);
  expect(answers).toBe(3);
  // The fallback: a subscribe with neither a cursor nor a tail, answered by the full snapshot.
  const subscribes = made.faults.sent
    .map((text) => JSON.parse(text) as { type: string; tail?: unknown; afterSeq?: unknown })
    .filter((sent) => sent.type === "subscribe");
  expect(subscribes.at(-1)).not.toHaveProperty("tail");
  expect(subscribes.at(-1)).not.toHaveProperty("afterSeq");
});
