import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * jsdom has no layout. The transcript virtualizer reads offsetHeight, so give its viewport a
 * tall box and every other element a row height; all rows of a test thread then mount.
 */
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

afterEach(() => cleanup());
