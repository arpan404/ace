import { describe, expect, it } from "vitest";
import { ClientMessage, DeliveryEvent, ServerMessage } from "./wire.ts";

describe("wire schemas", () => {
  it.each([
    { type: "hello", protocolVersion: 2, deviceId: "d", token: "s" },
    { type: "hello", protocolVersion: 1, deviceId: "d" },
    { type: "subscribe", subscriptionId: "s", scope: { kind: "thread" } },
    { type: "subscribe", subscriptionId: "s", scope: { kind: "threads" }, afterSeq: -1 },
    { type: "command", command: { id: "c", deviceId: "d", payload: { type: "unknown" } } },
  ])("rejects malformed client messages", (message) => {
    expect(ClientMessage.safeParse(message).success).toBe(false);
  });
  it("validates coalesced sequence ranges", () => {
    const event = {
      seq: 5,
      firstSeq: 2,
      id: "e",
      threadId: "t",
      at: 1,
      payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "abcd" },
    };
    expect(DeliveryEvent.safeParse({ ...event, firstSeq: 6 }).success).toBe(false);
    expect(
      DeliveryEvent.safeParse({ ...event, payload: { type: "thread.updated", title: "title" } })
        .success,
    ).toBe(false);
  });
  it("validates snapshots instead of accepting arbitrary JSON", () => {
    expect(
      ServerMessage.safeParse({ type: "snapshot", subscriptionId: "s", seq: 1, view: {} }).success,
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
  });
});
