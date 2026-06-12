import { describe, expect, it } from "vitest";

import { shouldHydrateActiveThreadFromReadModelFallback } from "./activeThreadHydration";
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
    expect(
      shouldHydrateActiveThreadFromReadModelFallback(
        thread({
          historyLoaded: false,
          latestTurn: {
            state: "running",
          } as Thread["latestTurn"],
          session: null,
        }),
      ),
    ).toBe(false);
  });

  it("skips threads with a running provider session", () => {
    expect(
      shouldHydrateActiveThreadFromReadModelFallback(
        thread({
          historyLoaded: false,
          latestTurn: null,
          session: {
            status: "running",
            orchestrationStatus: "running",
          } as Thread["session"],
        }),
      ),
    ).toBe(false);
  });
});
