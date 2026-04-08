import { TurnId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { hasLiveTurn } from "./phase";

describe("hasLiveTurn", () => {
  const liveTurn = {
    turnId: TurnId.makeUnsafe("turn-live"),
    state: "running" as const,
    startedAt: "2026-04-07T14:00:00.000Z",
    completedAt: null,
  };

  it("returns true while the session is actively running", () => {
    expect(
      hasLiveTurn(liveTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-live"),
      }),
    ).toBe(true);
  });

  it("returns true when the latest turn is still marked running after session phase drops", () => {
    expect(
      hasLiveTurn(liveTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false once the turn is completed and the session is no longer running", () => {
    expect(
      hasLiveTurn(
        {
          ...liveTurn,
          state: "completed",
          completedAt: "2026-04-07T14:01:00.000Z",
        },
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
      ),
    ).toBe(false);
  });
});
