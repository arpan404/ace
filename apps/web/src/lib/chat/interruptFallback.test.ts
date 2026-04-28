import { TurnId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { shouldEscalateInterruptToSessionStop } from "./interruptFallback";

const TURN_ID_1 = TurnId.makeUnsafe("turn-1");
const TURN_ID_2 = TurnId.makeUnsafe("turn-2");
const BASE_SESSION = {
  provider: "codex" as const,
  status: "running" as const,
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

describe("shouldEscalateInterruptToSessionStop", () => {
  it("returns true when the same turn is still live", () => {
    expect(
      shouldEscalateInterruptToSessionStop({
        thread: {
          latestTurn: {
            turnId: TURN_ID_1,
            state: "interrupted",
            requestedAt: "2026-04-27T00:00:00.000Z",
            startedAt: "2026-04-27T00:00:01.000Z",
            completedAt: "2026-04-27T00:00:02.000Z",
            assistantMessageId: null,
            sourceProposedPlan: undefined,
          },
          session: {
            ...BASE_SESSION,
            orchestrationStatus: "running",
            activeTurnId: undefined,
          },
        },
        interruptedTurnId: TURN_ID_1,
      }),
    ).toBe(true);
  });

  it("returns false once the session is no longer live", () => {
    expect(
      shouldEscalateInterruptToSessionStop({
        thread: {
          latestTurn: {
            turnId: TURN_ID_1,
            state: "interrupted",
            requestedAt: "2026-04-27T00:00:00.000Z",
            startedAt: "2026-04-27T00:00:01.000Z",
            completedAt: "2026-04-27T00:00:02.000Z",
            assistantMessageId: null,
            sourceProposedPlan: undefined,
          },
          session: {
            ...BASE_SESSION,
            status: "ready",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          },
        },
        interruptedTurnId: TURN_ID_1,
      }),
    ).toBe(false);
  });

  it("returns false when the live turn changed after the interrupt request", () => {
    expect(
      shouldEscalateInterruptToSessionStop({
        thread: {
          latestTurn: {
            turnId: TURN_ID_2,
            state: "running",
            requestedAt: "2026-04-27T00:00:00.000Z",
            startedAt: "2026-04-27T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
            sourceProposedPlan: undefined,
          },
          session: {
            ...BASE_SESSION,
            orchestrationStatus: "running",
            activeTurnId: undefined,
          },
        },
        interruptedTurnId: TURN_ID_1,
      }),
    ).toBe(false);
  });
});
