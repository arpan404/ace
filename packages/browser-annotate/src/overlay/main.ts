import { startOverlay } from "./overlay.ts";
import type { OverlayHandle, OverlayInit } from "./types.ts";

/**
 * Bundle entry, evaluated in the `ace-annotate` isolated world. Its globals are invisible to
 * the page's own scripts. Installing again replaces the previous overlay in this document.
 */
declare global {
  var aceAnnotate: OverlayHandle | undefined;
  var aceAnnotateInstall: ((init: OverlayInit) => string) | undefined;
}

globalThis.aceAnnotateInstall = (init) => {
  globalThis.aceAnnotate?.teardown();
  globalThis.aceAnnotate = undefined;
  const handle = startOverlay(init);
  globalThis.aceAnnotate = handle;
  return handle.documentId;
};
