import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { fallbackCharWidth, gutterWidth } from "./geometry.ts";
import type { EditorHandle } from "./types.ts";

/* Multi-cursor keys and clicks, on macOS. jsdom measures the fallback cell width. */

const cell = fallbackCharWidth;

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

function span(line: number, from: number, to: number) {
  return { anchor: { line, column: from }, head: { line, column: to } };
}

async function openEditor(text: string, lines = text.split("\n").length) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={text}
      commitAfter={20}
      highlightDelay={60_000}
    />,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  const at = (line: number, column: number) => ({
    clientX: gutterWidth(lines) + column * cell + 1,
    clientY: line * 22 + 5,
  });
  return { ref, scroller, at };
}

test("Shift+Cmd+L selects every occurrence of the word, and typing replaces them all", async () => {
  const { ref } = await openEditor("let a = a + b;\na");
  act(() => ref.current?.setSelections([caret(0, 4)]));
  await userEvent.keyboard("{Shift>}{Meta>}l{/Meta}{/Shift}");
  expect(ref.current?.selections()).toEqual([span(0, 4, 5), span(0, 8, 9), span(1, 0, 1)]);
  await userEvent.keyboard("x");
  expect(ref.current?.text()).toBe("let x = x + b;\nx");
});

test("Cmd+K Cmd+D moves the last occurrence on to the next one", async () => {
  const { ref } = await openEditor("ab ab ab");
  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Meta>}d{/Meta}");
  await userEvent.keyboard("{Meta>}d{/Meta}");
  await userEvent.keyboard("{Meta>}k{/Meta}{Meta>}d{/Meta}");
  expect(ref.current?.selections()).toEqual([span(0, 0, 2), span(0, 6, 8)]);
});

test("Cmd+U undoes the last cursor change, one at a time", async () => {
  const { ref } = await openEditor("ab ab ab");
  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Meta>}d{/Meta}{Meta>}d{/Meta}{Meta>}d{/Meta}");
  expect(ref.current?.selections()).toHaveLength(3);
  await userEvent.keyboard("{Meta>}u{/Meta}");
  expect(ref.current?.selections()).toEqual([span(0, 0, 2), span(0, 3, 5)]);
  await userEvent.keyboard("{Meta>}u{/Meta}");
  expect(ref.current?.selections()).toEqual([span(0, 0, 2)]);
});

test("Shift+Alt+I puts a caret at the end of every selected line", async () => {
  const { ref } = await openEditor("one\ntwo\nthree");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 1 }, head: { line: 2, column: 2 } }]),
  );
  await userEvent.keyboard("{Shift>}{Alt>}i{/Alt}{/Shift}");
  expect(ref.current?.selections()).toEqual([caret(0, 3), caret(1, 3), caret(2, 5)]);
});

test("Shift+Alt+Cmd+Down and Right grow a box selection", async () => {
  const { ref } = await openEditor("abcd\nab\nabcd");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await userEvent.keyboard(
    "{Shift>}{Alt>}{Meta>}{ArrowDown}{ArrowDown}{ArrowRight}{ArrowRight}{/Meta}{/Alt}{/Shift}",
  );
  expect(ref.current?.selections()).toEqual([span(0, 1, 3), span(1, 1, 2), span(2, 1, 3)]);
});

test("Escape with several cursors keeps only the primary one, as it is", async () => {
  const { ref } = await openEditor("ab ab");
  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Meta>}d{/Meta}{Meta>}d{/Meta}");
  await userEvent.keyboard("{Escape}");
  expect(ref.current?.selections()).toEqual([span(0, 3, 5)]);
  await userEvent.keyboard("{Escape}");
  expect(ref.current?.selections()).toEqual([caret(0, 5)]);
});

test("Alt+click adds a caret and Alt+drag adds a selection, keeping the others", async () => {
  const { ref, scroller, at } = await openEditor("abcdef\nabcdef");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  fireEvent.pointerDown(scroller, { button: 0, altKey: true, ...at(1, 2) });
  fireEvent.pointerUp(scroller, { button: 0, altKey: true, ...at(1, 2) });
  expect(ref.current?.selections()).toEqual([caret(0, 1), caret(1, 2)]);

  fireEvent.pointerDown(scroller, { button: 0, altKey: true, ...at(0, 3) });
  fireEvent.pointerMove(scroller, { buttons: 1, altKey: true, ...at(0, 5) });
  fireEvent.pointerUp(scroller, { button: 0, altKey: true, ...at(0, 5) });
  expect(ref.current?.selections()).toEqual([caret(0, 1), span(0, 3, 5), caret(1, 2)]);
});

test("Shift+Alt+drag makes a box from the caret", async () => {
  const { ref, scroller, at } = await openEditor("abcdef\nabcdef\nabcdef");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  fireEvent.pointerDown(scroller, { button: 0, altKey: true, shiftKey: true, ...at(1, 3) });
  fireEvent.pointerMove(scroller, { buttons: 1, altKey: true, shiftKey: true, ...at(2, 4) });
  fireEvent.pointerUp(scroller, { button: 0, ...at(2, 4) });
  expect(ref.current?.selections()).toEqual([span(0, 1, 4), span(1, 1, 4), span(2, 1, 4)]);
});
