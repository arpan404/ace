import { glyph } from "../glyph.ts";
import { bubble } from "../geometry.ts";
import { circle, line, shape, type Part } from "../parts.ts";

/** Two bubbles, one in front of the other; also the base of Chats. */
export const chatsCircle = (): Part[] => [
  line(bubble(15.25, 8.75, 5.75, true), { hole: circle(9.5, 14, 8.5) }),
  shape(bubble(9.5, 14, 6.5)),
];

/** Many conversations: a bubble in front of another, their tails apart. */
export const ChatsCircleIcon = /* @__PURE__ */ glyph("ChatsCircle", chatsCircle);
