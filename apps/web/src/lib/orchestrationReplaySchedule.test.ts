import { describe, expect, it } from "vitest";

import {
  ACTIVE_THREAD_REPLAY_INTERVAL_MS,
  IDLE_THREAD_REPLAY_INTERVAL_MS,
  resolveThreadReplayDelayMs,
} from "./orchestrationReplaySchedule";

describe("orchestrationReplaySchedule", () => {
  it("uses the active replay interval for visible running threads", () => {
    expect(
      resolveThreadReplayDelayMs({
        isThreadActive: true,
        visibilityState: "visible",
      }),
    ).toBe(ACTIVE_THREAD_REPLAY_INTERVAL_MS);
  });

  it("backs off replay for visible idle threads", () => {
    expect(
      resolveThreadReplayDelayMs({
        isThreadActive: false,
        visibilityState: "visible",
      }),
    ).toBe(IDLE_THREAD_REPLAY_INTERVAL_MS);
  });

  it("does not schedule replay while the document is hidden", () => {
    expect(
      resolveThreadReplayDelayMs({
        isThreadActive: true,
        visibilityState: "hidden",
      }),
    ).toBeNull();
  });
});
