import { glyph } from "../glyph.ts";
import { plussed } from "../parts.ts";
import { folder } from "./folder-simple.ts";

/** A new project: the folder with a plus. */
export const FolderPlusIcon = /* @__PURE__ */ glyph("FolderPlus", () => plussed(folder()));
