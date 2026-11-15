import { glyph } from "../glyph.ts";
import { bubble } from "../geometry.ts";
import { circle, line, shape } from "../parts.ts";

/** Many conversations: a bubble in front of another, their tails apart. */
export const ChatsCircleIcon = /* @__PURE__ */ glyph("ChatsCircle", () => [
  line(bubble(15.25, 8.75, 5.75, true), { hole: circle(9.5, 14, 8.5) }),
  shape(bubble(9.5, 14, 6.5)),
]);
