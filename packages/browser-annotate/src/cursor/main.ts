import type { CursorInit } from "../cursor-init.ts";
import { startCursor, type CursorHandle } from "./overlay.ts";

/**
 * Bundle entry, evaluated in the `ace-cursor` isolated world. Its globals are invisible to the
 * page's own scripts. Installing again replaces the previous layer in this document.
 */
declare global {
  var aceCursor: CursorHandle | undefined;
  var aceCursorInstall: ((init: CursorInit) => string) | undefined;
}

globalThis.aceCursorInstall = (init) => {
  if (globalThis.aceCursor) return globalThis.aceCursor.documentId;
  const handle = startCursor(init);
  globalThis.aceCursor = handle;
  return handle.documentId;
};
