import { MessageId, TurnId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { isPagedThreadTimelineUsable } from "./pagedTimelineCompleteness";

const turnId = TurnId.makeUnsafe("turn-1");

describe("isPagedThreadTimelineUsable", () => {
  it("allows running turns to render partial live state", () => {
    expect(
      isPagedThreadTimelineUsable({
        latestTurn: {
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          completedAt: null,
          state: "running",
          turnId,
        },
        leanMessages: [],
        pagedMessages: [],
      }),
    ).toBe(true);
  });

  it("blocks settled paged history until the latest assistant message is fetched", () => {
    expect(
      isPagedThreadTimelineUsable({
        latestTurn: {
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          completedAt: "2026-01-01T00:00:03.000Z",
          state: "completed",
          turnId,
        },
        leanMessages: [],
        pagedMessages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            turnId,
          },
        ],
      }),
    ).toBe(false);
  });

  it("allows settled paged history when the latest assistant message is present", () => {
    expect(
      isPagedThreadTimelineUsable({
        latestTurn: {
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          completedAt: "2026-01-01T00:00:03.000Z",
          state: "completed",
          turnId,
        },
        leanMessages: [],
        pagedMessages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            turnId,
          },
        ],
      }),
    ).toBe(true);
  });

  it("blocks completed latest-turn lean user fallback until a matching assistant is fetched", () => {
    expect(
      isPagedThreadTimelineUsable({
        latestTurn: {
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:03.000Z",
          state: "completed",
          turnId,
        },
        leanMessages: [
          {
            role: "user",
            turnId,
          },
        ],
        pagedMessages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            turnId,
          },
        ],
      }),
    ).toBe(false);
  });

  it("allows completed latest-turn lean user fallback once a matching assistant is fetched", () => {
    expect(
      isPagedThreadTimelineUsable({
        latestTurn: {
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:03.000Z",
          state: "completed",
          turnId,
        },
        leanMessages: [
          {
            role: "user",
            turnId,
          },
        ],
        pagedMessages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            turnId,
          },
        ],
      }),
    ).toBe(true);
  });
});
