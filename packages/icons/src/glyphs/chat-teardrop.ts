import { glyph } from "../glyph.ts";
import { detail, dot } from "../parts.ts";
import { chatCircle } from "./chat-circle.ts";

/** An agent is asking: the bubble with a question mark. */
export const ChatTeardropIcon = /* @__PURE__ */ glyph("ChatTeardrop", () => [
  ...chatCircle(),
  detail("M9.9 8.9a2.15 2.15 0 1 1 3.05 1.95c-.6.3-.95.8-.95 1.4v.2"),
  dot(12, 15, 1.1),
]);
