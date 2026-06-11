import {
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationTimelineRow,
} from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCachedNativeTimelineRows,
  readCachedNativeTimelineRows,
  resolveNativeTimelineRows,
} from "./nativeTimelineRowsClient";

const turnId = TurnId.makeUnsafe("turn-native-rows-client");
const messageId = MessageId.makeUnsafe("message-native-rows-client");
const cacheKey = "rev:native-rows-client";

function createMessage(): OrchestrationMessage {
  return {
    id: messageId,
    role: "assistant",
    text: "Cached render rows",
    turnId,
    streaming: false,
    sequence: 1,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
}

function createTimelineRow(message: OrchestrationMessage): OrchestrationTimelineRow {
  return {
    id: `message:${message.id}`,
    kind: "message",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    contentVersion: `v1:message:${message.id}:${message.updatedAt}`,
    startSourceIndex: 0,
    endSourceIndexExclusive: 1,
    turnId: message.turnId,
    sourceRefs: [
      {
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        sourceIndex: 0,
        turnId: message.turnId,
        sequence: message.sequence,
      },
    ],
  };
}

afterEach(() => {
  clearCachedNativeTimelineRows(cacheKey);
  vi.unstubAllGlobals();
});

describe("nativeTimelineRowsClient", () => {
  it("reuses cached render rows for an unchanged snapshot key", async () => {
    vi.stubGlobal("Worker", undefined);
    const message = createMessage();
    const rowsInput = {
      rows: [createTimelineRow(message)],
      messages: [message],
      activities: [],
      proposedPlans: [],
      activeTurnInProgress: false,
      activeTurnStartedAt: null,
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
    };

    const firstRows = await resolveNativeTimelineRows({ cacheKey, rowsInput });
    const secondRows = await resolveNativeTimelineRows({ cacheKey, rowsInput });

    expect(readCachedNativeTimelineRows(cacheKey)).toBe(firstRows);
    expect(secondRows).toBe(firstRows);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ kind: "message", id: `message:${messageId}` });
  });
});
