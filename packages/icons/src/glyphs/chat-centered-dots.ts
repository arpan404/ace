import { glyph } from "../glyph.ts";
import { dot } from "../parts.ts";
import { chatCircle } from "./chat-circle.ts";

/** A page is asking something: the bubble with three dots. */
export const ChatCenteredDotsIcon = /* @__PURE__ */ glyph("ChatCenteredDots", () => [
  ...chatCircle(),
  dot(8.25, 11.25, 1.2),
  dot(12, 11.25, 1.2),
  dot(15.75, 11.25, 1.2),
]);
