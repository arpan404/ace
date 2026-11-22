import { glyph } from "../glyph.ts";
import { line, type Part } from "../parts.ts";

/** Lines kept to the left edge: long and short lines, left aligned. */
export const textAlignLeft = (): Part[] => [line("M3.5 5h17M3.5 10h11M3.5 15h17M3.5 20h11")];

export const TextAlignLeftIcon = /* @__PURE__ */ glyph("TextAlignLeft", textAlignLeft);
