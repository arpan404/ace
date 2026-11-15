import { glyph } from "../glyph.ts";
import { line } from "../parts.ts";
import { screen } from "./monitor.ts";

/** A desktop computer: the screen on its stand. */
export const DesktopIcon = /* @__PURE__ */ glyph("Desktop", () => [
  ...screen(),
  line("M12 17v3.5M8 20.5h8"),
]);
