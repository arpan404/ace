import { readFileSync } from "node:fs";
import { join } from "node:path";
import { preloadMarkit } from "@ace/markit-web/react";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Lazy routes may need their first transform before their controls can appear.
configure({ asyncUtilTimeout: 10_000 });

/*
 * jsdom has no layout. The transcript virtualizer reads offsetHeight, so give its viewport a
 * tall box and every other element a row height; all rows of a test thread then mount.
 */
// A test may opt into the node environment (a real browser driven from node): no DOM to shim.
if (typeof HTMLElement !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-virtual-viewport") ? 100_000 : 40;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  window.scrollTo = () => {};
  /*
   * jsdom has no Worker, so markit renders in-process. Left alone, its Wasm glue fetches the
   * module from Vite's dev-server URL, which nothing serves in a test: every answer would stay
   * the plain-text fallback. Hand it the bytes the postinstall build produced instead.
   */
  preloadMarkit({
    worker: "inline",
    wasm: readFileSync(
      join(import.meta.dirname, "../../../../packages/markit/web/pkg/markit_wasm_bg.wasm"),
    ),
  });
}

afterEach(() => cleanup());
