import { describe, expect, it } from "vitest";
import type { OrchestrationLatestTurn } from "@ace/contracts";

import { deriveStuckTurnSnapshot } from "./stuckTurn";

const now = Date.parse("2026-05-21T12:00:00.000Z");

function runningTurn(startedAtMs: number): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as OrchestrationLatestTurn["turnId"],
    state: "running",
    requestedAt: new Date(startedAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: null,
    assistantMessageId: null,
  };
}

describe("deriveStuckTurnSnapshot", () => {
  it("does not flag a recent running turn", () => {
    expect(
      deriveStuckTurnSnapshot({
        latestTurn: runningTurn(now - 30_000),
        messages: [],
        activities: [],
        now,
      }).isLikelyStuck,
    ).toBe(false);
  });

  it("flags a turn with no recent events after 90 seconds", () => {
    expect(
      deriveStuckTurnSnapshot({
        latestTurn: runningTurn(now - 91_000),
        messages: [],
        activities: [],
        now,
      }),
    ).toMatchObject({
      isLikelyStuck: true,
      reason: "long-running-no-events",
    });
  });

  it("flags a turn running longer than ten minutes", () => {
    expect(
      deriveStuckTurnSnapshot({
        latestTurn: runningTurn(now - 601_000),
        messages: [
          {
            id: "message-1" as never,
            role: "assistant",
            text: "working",
            turnId: "turn-1" as never,
            createdAt: new Date(now - 120_000).toISOString(),
            streaming: false,
          },
        ],
        activities: [],
        now,
      }),
    ).toMatchObject({
      isLikelyStuck: true,
      reason: "long-running",
    });
  });

  it("suppresses stuck state when recent output arrived", () => {
    expect(
      deriveStuckTurnSnapshot({
        latestTurn: runningTurn(now - 601_000),
        messages: [],
        activities: [
          {
            id: "event-1" as never,
            tone: "tool",
            kind: "terminal.output",
            summary: "output",
            payload: {},
            turnId: "turn-1" as never,
            createdAt: new Date(now - 10_000).toISOString(),
          },
        ],
        now,
      }).isLikelyStuck,
    ).toBe(false);
  });
});
