import { glyph } from "../glyph.ts";
import { arc, polygon } from "../geometry.ts";
import { line, shape, type Part } from "../parts.ts";

/** A speaker: a box with its cone opening right, `dx` across; also the base of the muted speaker. */
export const speaker = (dx = 0): Part[] => [
  shape(
    polygon([
      [2.75 + dx, 9, 1.75],
      [6.75 + dx, 9, 0.8],
      [12.25 + dx, 4.5, 1.5],
      [12.25 + dx, 19.5, 1.5],
      [6.75 + dx, 15, 0.8],
      [2.75 + dx, 15, 1.75],
    ]),
  ),
];

/** Playing sound: the speaker sending out two waves. */
export const SpeakerHighIcon = /* @__PURE__ */ glyph("SpeakerHigh", () => [
  ...speaker(),
  line(arc(13, 12, 3.25, -50, 50)),
  line(arc(13, 12, 7, -50, 50)),
]);
