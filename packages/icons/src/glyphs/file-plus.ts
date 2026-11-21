import { glyph } from "../glyph.ts";
import { plussed } from "../parts.ts";
import { page } from "./file.ts";

/** A new file: the page with a plus. */
export const FilePlusIcon = /* @__PURE__ */ glyph("FilePlus", () => plussed(page()));
