import { afterEach, expect, test } from "vitest";
import { Agent, Item, type EventPayload } from "@ace/protocol";
import { setup, ready, barrier } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const agent = (threadId: string, id: string, parentId: string | null) =>
  Agent.parse({
    id,
    threadId,
    parentId,
    origin: parentId ? "provider_subagent" : "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "starting" },
    createdAt: 1,
  });
const say = (id: string, agentId: string): EventPayload => ({
  type: "item.created",
  item: Item.parse({
    id,
    agentId,
    type: "message",
    role: id === "ask" ? "user" : "assistant",
    createdAt: 1,
    complete: true,
    parts: [{ type: "text", text: id }],
  }),
});

test("a resnapshot after busy subagent output holds the same root items the live window kept", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const threadId = h.thread.id;
  const agents = [agent(threadId, "root", null), agent(threadId, "sub", "root")];
  h.daemon.store.appendEvents(threadId, [
    ...agents.map((value): EventPayload => ({ type: "agent.created", agent: value })),
    say("ask", "root"),
    say("reply", "root"),
  ]);
  const live = h.make();
  await ready(live.client);
  const watched = live.client.thread(threadId).store;
  await barrier(live.client, threadId);
  // The subagent writes far more than the window holds while the client follows live.
  for (let batch = 0; batch < 3; batch++)
    h.daemon.store.appendEvents(
      threadId,
      Array.from({ length: 100 }, (_, n) => say(`step-${batch * 100 + n}`, "sub")),
    );
  await barrier(live.client, threadId);
  const held = [...watched.order];
  expect(held).toHaveLength(200);
  expect(held.slice(0, 2)).toEqual(["ask", "reply"]);
  expect(held.at(-1)).toBe("step-299");
  // A client opening the thread now (a reload, or a reconnect past its cursor) reads the
  // daemon's snapshot: the same items, in the same order, with the same history cursor.
  const fresh = h.make();
  await ready(fresh.client);
  const snapshot = fresh.client.thread(threadId).store;
  await barrier(fresh.client, threadId);
  expect(snapshot.order).toEqual(held);
  expect(snapshot.itemsBefore).toBe(watched.itemsBefore);
});
