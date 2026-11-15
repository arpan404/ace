import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";

/** A built-in command: the looped command key. */
export const CommandIcon = /* @__PURE__ */ glyph("Command", () => [
  line(
    "M9 15V6.75A2.75 2.75 0 1 0 6.25 9.5H17.75A2.75 2.75 0 1 0 15 6.75V17.25A2.75 2.75 0 1 0 17.75 14.5H6.25A2.75 2.75 0 1 0 9 17.25Z",
  ),
]);
