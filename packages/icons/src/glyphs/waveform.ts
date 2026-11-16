import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";

/** Talk, or a voice: bars of a sound wave, tallest in the middle. */
export const WaveformIcon = /* @__PURE__ */ glyph("Waveform", () => [
  line("M4 10.25v3.5"),
  line("M8 6.75v10.5"),
  line("M12 3.5v17"),
  line("M16 7.5v9"),
  line("M20 10.25v3.5"),
]);
