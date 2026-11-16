import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape } from "../parts.ts";

/** Queued messages: a card with more waiting behind it. */
export const QueueIcon = /* @__PURE__ */ glyph("Queue", () => [
  line("M8 3.75h8"),
  line("M5.5 7h13"),
  shape(rect(3, 10.25, 18, 10, 4)),
]);
