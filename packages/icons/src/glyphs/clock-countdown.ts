import { glyph } from "../glyph.ts";
import { spot } from "../parts.ts";
import { clockFace } from "./clock.ts";

/** Waiting its turn: a clock face with a quarter of its time still to run. */
export const ClockCountdownIcon = /* @__PURE__ */ glyph("ClockCountdown", () => [
  clockFace(),
  spot("M12 12V6.25a5.75 5.75 0 0 1 5.75 5.75Z"),
]);
