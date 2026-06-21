import type { OrchestrationMessage } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { upsertThreadMessage } from "./threadMessages";

const asMessageId = (value: string): OrchestrationMessage["id"] =>
  value as OrchestrationMessage["id"];

function makeMessage(overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: asMessageId("message-1"),
    role: "assistant",
    text: "hello",
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("upsertThreadMessage", () => {
  it("inserts new messages in deterministic chronological order", () => {
    const newer = makeMessage({
      id: asMessageId("message-2"),
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    const olderIncoming = makeMessage({
      id: asMessageId("message-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const result = upsertThreadMessage([newer], olderIncoming);

    expect(result.map((message) => message.id)).toEqual(["message-1", "message-2"]);
  });

  it("updates existing messages and preserves prior attachments when omitted", () => {
    const existing = makeMessage({
      id: asMessageId("message-1"),
      text: "partial",
      streaming: true,
      attachments: [{ kind: "file", id: "a", label: "A" }] as never,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const streamedUpdate = makeMessage({
      id: asMessageId("message-1"),
      text: "final",
      streaming: false,
      attachments: undefined,
      updatedAt: "2026-01-01T00:00:03.000Z",
    });

    const result = upsertThreadMessage([existing], streamedUpdate);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("final");
    expect(result[0]?.streaming).toBe(false);
    expect(result[0]?.attachments).toEqual(existing.attachments);
  });

  it("prioritizes sequence ordering when sequence is present", () => {
    const sequenceTwo = makeMessage({
      id: asMessageId("message-2"),
      sequence: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const sequenceOneIncoming = makeMessage({
      id: asMessageId("message-1"),
      sequence: 1,
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });

    const result = upsertThreadMessage([sequenceTwo], sequenceOneIncoming);

    expect(result.map((message) => message.sequence)).toEqual([1, 2]);
  });
});
