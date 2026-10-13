import { expect, test } from "vitest";
import { liveIndicatorsHeld } from "./live-motion.ts";

test.each(["connecting", "starting", "ready"] as const)(
  "live spinners keep moving while the connection is %s",
  (state) => {
    expect(liveIndicatorsHeld(state)).toBe(false);
  },
);

test.each(["reconnecting", "offline", "fatal"] as const)(
  "live spinners hold still while the connection is %s",
  (state) => {
    expect(liveIndicatorsHeld(state)).toBe(true);
  },
);
