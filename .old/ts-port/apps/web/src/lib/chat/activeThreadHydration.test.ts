import { describe, expect, it } from "vitest";
import { TurnId } from "@ace/contracts";

import {
  isThreadLiveWorkActive,
  shouldHydrateActiveThreadFromReadModelFallback,
} from "./activeThreadHydration";
import type { Thread } from "../../types";

function thread(partial: Pick<Thread, "historyLoaded" | "latestTurn" | "session">) {
  return partial as Thread;
}

describe("active thread hydration", () => {
  it("uses the read-model fallback for idle metadata-only threads", () => {
    expect(
      shouldHydrateActiveThreadFromReadModelFallback(
        thread({
          historyLoaded: false,
          latestTurn: null,
          session: null,
        }),
      ),
    ).toBe(true);
  });

  it("skips already hydrated threads", () => {
    expect(
      shouldHydrateActiveThreadFromReadModelFallback(
        thread({
          historyLoaded: true,
          latestTurn: null,
          session: null,
        }),
      ),
    ).toBe(false);
  });

  it("skips threads with a running latest turn", () => {
    const turnId = TurnId.makeUnsafe("turn-latest-running");
    const runningThread = thread({
      historyLoaded: false,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      } as Thread["latestTurn"],
      session: null,
    });

    expect(isThreadLiveWorkActive(runningThread)).toBe(true);
    expect(shouldHydrateActiveThreadFromReadModelFallback(runningThread)).toBe(false);
  });

  it("skips threads with a running provider session", () => {
    const turnId = TurnId.makeUnsafe("turn-running");
    const runningThread = thread({
      historyLoaded: false,
      latestTurn: null,
      session: {
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
      } as Thread["session"],
    });

    expect(isThreadLiveWorkActive(runningThread)).toBe(true);
    expect(shouldHydrateActiveThreadFromReadModelFallback(runningThread)).toBe(false);
  });

  it("uses the read-model fallback when the active session turn completed locally", () => {
    const turnId = TurnId.makeUnsafe("turn-completed");
    const completedThread = thread({
      historyLoaded: false,
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
        assistantMessageId: null,
      },
      session: {
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
      } as Thread["session"],
    });

    expect(isThreadLiveWorkActive(completedThread)).toBe(false);
    expect(shouldHydrateActiveThreadFromReadModelFallback(completedThread)).toBe(true);
  });
});
