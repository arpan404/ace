import { describe, expect, it } from "vitest";
import { DeliveryEvent, ServerMessage } from "./wire.ts";

describe("wire schemas", () => {
  it("validates coalesced sequence ranges", () => {
    const event = {
      seq: 5,
      firstSeq: 2,
      id: "e",
      threadId: "t",
      at: 1,
      payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "abcd" },
    };
    expect(DeliveryEvent.safeParse(event).success).toBe(true);
    expect(DeliveryEvent.safeParse({ ...event, firstSeq: 6 }).success).toBe(false);
    expect(
      DeliveryEvent.safeParse({ ...event, payload: { type: "thread.updated", title: "title" } })
        .success,
    ).toBe(false);
  });
  it("rejects a snapshot whose envelope disagrees with its continuation cursor", () => {
    const result = ServerMessage.safeParse({
      type: "snapshot",
      subscriptionId: "s",
      seq: 3,
      view: { kind: "threads", seq: 2, threads: {} },
    });
    expect(result.success).toBe(false);
    expect(
      ServerMessage.safeParse({
        type: "snapshot",
        subscriptionId: "s",
        seq: 3,
        view: { kind: "threads", seq: 3, threads: {} },
      }).success,
    ).toBe(true);
  });
  it("allows scoped holes but rejects event ranges outside the delivery watermark", () => {
    const event = {
      seq: 5,
      id: "e",
      at: 5,
      threadId: "t",
      payload: { type: "thread.updated", title: "Changed" },
    };
    const batch = {
      type: "events",
      subscriptionId: "s",
      afterSeq: 2,
      throughSeq: 8,
      events: [event],
    };
    expect(ServerMessage.safeParse(batch).success).toBe(true);
    expect(ServerMessage.safeParse({ ...batch, throughSeq: 4 }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...batch, events: [event, event] }).success).toBe(false);
    expect(
      ServerMessage.safeParse({ type: "progress", subscriptionId: "s", afterSeq: 2, throughSeq: 8 })
        .success,
    ).toBe(true);
    expect(
      ServerMessage.safeParse({ type: "progress", subscriptionId: "s", afterSeq: 8, throughSeq: 2 })
        .success,
    ).toBe(false);
  });
});
