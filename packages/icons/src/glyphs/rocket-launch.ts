import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { rocket } from "./rocket.ts";

/** A rocket reaction: a rocket climbing to the upper right. */
export const RocketLaunchIcon = /* @__PURE__ */ glyph("RocketLaunch", () => [
  ...rocket(45, 13, 11).slice(0, 4),
  line("M5 15.5 3.25 17.25M8.5 19 6.75 20.75"),
]);
