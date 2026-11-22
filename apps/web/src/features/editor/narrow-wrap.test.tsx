import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodeEditor } from "./editor.tsx";

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
