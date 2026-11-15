import { glyph } from "../glyph.ts";
import { detail } from "../parts.ts";
import { cube } from "./cube.ts";

/** An app to install: the cube as a box, with tape across its lid. */
export const PackageIcon = /* @__PURE__ */ glyph("Package", () => [
  ...cube(),
  detail("M7.9 4.75 16.1 9.25v2.75"),
]);
