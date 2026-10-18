import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { overlayBoxes } from "./overlays.ts";

const original = HTMLElement.prototype.getBoundingClientRect;
const sized = new Map<Element, DOMRect>();

/** A child of <body> (jsdom has no layout: `rect` stands for where it is drawn). */
function add(rect: DOMRect | undefined, z?: number, parent: Element = document.body) {
  const element = document.createElement("div");
  if (z !== undefined) element.style.zIndex = String(z);
  if (rect) sized.set(element, rect);
  parent.append(element);
  return element;
}

beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return sized.get(this) ?? new DOMRect(0, 0, 0, 0);
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = original;
});

afterEach(() => {
  document.body.replaceChildren();
  sized.clear();
});

const screenBox = new DOMRect(0, 0, 1440, 900);
const page = new DOMRect(600, 500, 320, 200);

test("a page in the app is covered by any portal drawn over it", () => {
  const app = add(screenBox);
  const area = add(page, undefined, app);
  const menu = add(undefined);
  const popup = add(new DOMRect(700, 520, 200, 160), 110, menu);
  expect(overlayBoxes(area)).toEqual([popup.getBoundingClientRect()]);
});

test("a floating window's page is not covered by the app beneath it, only by what is above it", () => {
  // The app fills the window; picture-in-picture floats over it.
  add(screenBox);
  const floating = add(undefined, 40);
  const area = add(page, undefined, floating);
  expect(overlayBoxes(area)).toEqual([]);
  // A toast portalled before the window opened still paints above it, by its z-index.
  const toasts = document.createElement("div");
  document.body.insertBefore(toasts, floating);
  const toast = add(new DOMRect(620, 520, 300, 48), 150, toasts);
  // Something portalled later at a lower z-index stays beneath it.
  add(new DOMRect(0, 0, 400, 400), 10);
  expect(overlayBoxes(area)).toEqual([toast.getBoundingClientRect()]);
});
