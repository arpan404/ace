import { glyph } from "../glyph.ts";
import { detail, shape } from "../parts.ts";

/** Storage: a cylinder with its top rim and one band. */
export const DatabaseIcon = /* @__PURE__ */ glyph("Database", () => [
  shape(
    "M4.5 6c0-1.8 3.36-3.25 7.5-3.25S19.5 4.2 19.5 6v12c0 1.8-3.36 3.25-7.5 3.25S4.5 19.8 4.5 18Z",
  ),
  detail("M4.9 6.75c.9 1.45 3.7 2.5 7.1 2.5s6.2-1.05 7.1-2.5"),
  detail("M4.9 12.75c.9 1.45 3.7 2.5 7.1 2.5s6.2-1.05 7.1-2.5"),
]);
