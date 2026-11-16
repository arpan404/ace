import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { bellBody } from "./bell.ts";

/** Notification settings: the bell with a flat bar for its clapper. */
export const BellSimpleIcon = /* @__PURE__ */ glyph("BellSimple", () => [
  bellBody(),
  line("M9.75 20.5h4.5"),
]);
