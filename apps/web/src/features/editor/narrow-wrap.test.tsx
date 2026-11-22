import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { fallbackCharWidth, gutterWidth } from "./geometry.ts";

/*
 * Beside the chat the editor is narrow: long lines wrap there even with the wrap setting off,
 * and Alt+Z still turns it off for that editor. With the setting on, lines always wrap.
 */

const wide = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: wide, configurable: true });
});

function at(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

const long = `const message = "${"a long string that runs on and on ".repeat(6)}";`;
const rows = () => document.querySelectorAll("[data-row]").length;

function rect(width: number): DOMRect {
  const box = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, width, height: 600 };
  return { ...box, toJSON: () => box };
}

async function open(wrap: boolean, onToggleWrap = () => {}) {
  render(
    <CodeEditor
      path="a.ts"
      label="Editor"
      text={long}
      wrap={wrap}
      onToggleWrap={onToggleWrap}
      highlightDelay={60_000}
    />,
  );
  return screen.findByRole("textbox", { name: "a.ts" });
}

test("a narrow editor wraps long lines with the wrap setting off", async () => {
  at(480);
  await open(false);

  await waitFor(() => expect(rows()).toBeGreaterThan(1));
});

test("a wide editor leaves long lines unwrapped with the wrap setting off", async () => {
  at(1600);
  await open(false);

  await waitFor(() => expect(document.querySelector("[data-row]")).not.toBeNull());
  expect(rows()).toBe(1);
});

test("Alt+Z unwraps a narrow editor that wrapped by itself, then wraps it again", async () => {
  at(480);
  const toggle = vi.fn();
  const box = await open(false, toggle);
  await waitFor(() => expect(rows()).toBeGreaterThan(1));

  fireEvent.keyDown(box, { key: "Ω", code: "KeyZ", altKey: true });
  await waitFor(() => expect(rows()).toBe(1));
  expect(toggle).not.toHaveBeenCalled();

  fireEvent.keyDown(box, { key: "Ω", code: "KeyZ", altKey: true });
  await waitFor(() => expect(rows()).toBeGreaterThan(1));
});

test("wrapped rows end inside a vertical scrollbar, so the editor never scrolls sideways", async () => {
  // The scroller is 400px wide, 10px of it a vertical scrollbar.
  // Only boxes are measured; a font's cell (a span) keeps the unmeasured width.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rect(this.tagName === "SPAN" ? 0 : 400);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  await open(true);
  await waitFor(() => expect(rows()).toBeGreaterThan(1));

  const widest = Math.max(
    ...Array.from(document.querySelectorAll("[data-row-text]"), (row) => row.textContent.length),
  );
  // The row's text, its gutter and its right padding all fit in what the scrollbar leaves.
  expect(gutterWidth(1) + widest * fallbackCharWidth + 24).toBeLessThanOrEqual(390);
  vi.restoreAllMocks();
});
