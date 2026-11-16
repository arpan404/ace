import { glyph } from "../glyph.ts";
import { detail, shape } from "../parts.ts";

/** Thinking: a brain, its two halves apart. */
export const BrainIcon = /* @__PURE__ */ glyph("Brain", () => [
  shape(
    "M12 5.25a3.1 3.1 0 0 1 5.65.9 3.6 3.6 0 0 1 2.1 5.6 3.4 3.4 0 0 1-2.4 5.95A3.1 3.1 0 0 1 12 19.5a3.1 3.1 0 0 1-5.35-1.8 3.4 3.4 0 0 1-2.4-5.95 3.6 3.6 0 0 1 2.1-5.6 3.1 3.1 0 0 1 5.65-.9Z",
  ),
  detail("M12 5.5v13.75M15 9.75c.75 1.25.5 2.75-.75 3.5M9 9.75c-.75 1.25-.5 2.75.75 3.5"),
]);
