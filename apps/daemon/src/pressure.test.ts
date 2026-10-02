import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Event, type DeliveryEvent } from "@ace/protocol";
import { coalesceEvents } from "./outbox.ts";
import { fixture } from "./socket-test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
  vi.useRealTimers();
});
const delta = Event.parse({
  seq: 1,
  id: "e1",
  at: 1,
  threadId: "t",
  payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "A" },
});
function next(changes: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    ...delta,
    id: Event.parse({ ...delta, id: "e2" }).id,
    seq: 2,
    payload: { ...delta.payload, append: "B" } as DeliveryEvent["payload"],
    ...changes,
  };
}
describe("delta coalescing", () => {
  it("concatenates adjacent matching ranges while preserving their first and last sequences", () => {
    const result = coalesceEvents([delta, next(), next({ seq: 4, firstSeq: 3 })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ firstSeq: 1, seq: 4, payload: { append: "ABB" } });
  });
  it.each([
    ["host sequence gap", next({ seq: 3 })],
    [
      "different field",
      next({
        payload: { ...delta.payload, field: "reasoning", append: "B" } as DeliveryEvent["payload"],
      }),
    ],
    [
      "different item",
      Event.parse({ ...next(), payload: { ...delta.payload, itemId: "other", append: "B" } }),
    ],
    [
      "different agent",
      Event.parse({ ...next(), payload: { ...delta.payload, agentId: "other", append: "B" } }),
    ],
    ["different thread", Event.parse({ ...next(), threadId: "other" })],
    [
      "authoritative metadata",
      Event.parse({ ...next(), payload: { type: "thread.updated", title: "title" } }),
    ],
  ])("keeps %s separate", (_name, second) => {
    expect(coalesceEvents([delta, second])).toEqual([delta, second]);
  });
  it("never concatenates deltas across an authoritative item update", () => {
    const update = Event.parse({
      ...next(),
      payload: {
        type: "item.updated",
        item: {
          id: "i",
          agentId: "a",
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "Reset" }],
          createdAt: 1,
          complete: false,
        },
      },
    });
    const tail = next({ seq: 3 });
    expect(coalesceEvents([delta, update, tail])).toEqual([delta, update, tail]);
  });
});
describe("socket pressure", () => {
  it("closes when queued deliveries cross the 4 MiB cap even with an empty transport buffer", async () => {
    const f = await fixture({ pressure: { softLimit: -1 } });
    cleanups.push(() => f.close());
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    await client.next();
    const closed = once(client.socket, "close").then((args) => args[0] as number);
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", title: "X".repeat(4 * 1024 * 1024) },
    ]);
    if (client.socket.readyState === client.socket.OPEN) client.send({ type: "ping" });
    const result = await Promise.race([
      closed,
      client.next().then(
        () => "message",
        () => closed,
      ),
    ]);
    expect(result).toBe(4009);
  });
  it("allows temporary pressure but closes once pressure persists for the configured interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = await fixture({ pressure: { hardLimit: -1, hardTimeoutMs: 1000 } });
    cleanups.push(() => f.close());
    const client = await f.connect();
    expect((await client.next()).type).toBe("welcome");
    vi.advanceTimersByTime(999);
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    const closed = once(client.socket, "close").then((args) => args[0] as number);
    vi.advanceTimersByTime(1);
    if (client.socket.readyState === client.socket.OPEN) client.send({ type: "ping" });
    const result = await Promise.race([
      closed,
      client.next().then(
        () => "message",
        () => closed,
      ),
    ]);
    expect(result).toBe(4009);
  });
});
