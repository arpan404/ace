import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Dictate: a microphone on its stand. */
export const MicrophoneIcon = /* @__PURE__ */ glyph("Microphone", () => [
  shape(rect(8.75, 2.5, 6.5, 12, 3.25)),
  line("M5.25 11a6.75 6.75 0 0 0 13.5 0"),
  line("M12 17.75v3"),
]);
