import { glyph } from "../glyph.ts";
import { detail, type Part } from "../parts.ts";
import { cube } from "./cube.ts";

/** The cube as a box, with tape across its lid. */
export const packageBox = (): Part[] => [...cube(), detail("M7.9 4.75 16.1 9.25v2.75")];

/** An app to install: the cube as a box, with tape across its lid. */
export const PackageIcon = /* @__PURE__ */ glyph("Package", packageBox);
