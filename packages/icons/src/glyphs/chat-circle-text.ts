import { glyph } from "../glyph.ts";
import { detail, type Part } from "../parts.ts";
import { chatCircle } from "./chat-circle.ts";

/** The bubble with two lines of text in it; shared by every "message with words" icon. */
export const chatText = (): Part[] => [...chatCircle(), detail("M8.25 9.5h7.5M8.25 13h4.5")];

/** A message: the bubble with lines of text. */
export const ChatCircleTextIcon = /* @__PURE__ */ glyph("ChatCircleText", chatText);
