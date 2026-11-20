import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { guideLevels, whitespaceMarks, wordAtCaret, wordOccurrences } from "./decorations.ts";
import { CodeEditor } from "./editor.tsx";
import type { CodeEditorProps, EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

async function openEditor(text: string, props: Partial<CodeEditorProps> = {}) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={text}
      highlightDelay={60_000}
      {...props}
    />,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  return ref;
}

const at = (lines: string[]) => (line: number) => lines[line] ?? "";

test("the caret's word is the one it is in or just after", () => {
  expect(wordAtCaret("let value = 1", 6)).toEqual({ start: 4, end: 9 });
  expect(wordAtCaret("let value = 1", 9)).toEqual({ start: 4, end: 9 });
  expect(wordAtCaret("a  b", 2)).toBeUndefined();
});

test("occurrences are whole words on the lines asked for", () => {
  const lines = ["id ids id", "x", "id"];
  expect(wordOccurrences(at(lines), 0, 2, "id")).toEqual([
    { start: { line: 0, column: 0 }, end: { line: 0, column: 2 } },
    { start: { line: 0, column: 7 }, end: { line: 0, column: 9 } },
  ]);
});

test("guide levels follow indentation, and blank lines take the smaller side", () => {
  const lines = ["a {", "    b {", "        c", "", "    }", "}"];
  expect(guideLevels(at(lines), 0, 6, 6, 4)).toEqual([0, 1, 2, 1, 1, 0]);
  expect(guideLevels(at(["\tx"]), 0, 1, 1, 2)).toEqual([1]);
});

test("whitespace marks name each space and tab in the range", () => {
  expect(whitespaceMarks("a b\tc", 0, 5)).toEqual([
    { column: 1, tab: false },
    { column: 3, tab: true },
  ]);
});

test("a caret next to a bracket highlights the pair, and the word's other occurrences light up", async () => {
  const ref = await openEditor("f(count)\ncount + 1");
  act(() => ref.current?.setSelections([caret(0, 4)]));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-decoration="occurrence"]')).toHaveLength(2),
  );
  act(() => ref.current?.setSelections([caret(0, 2)]));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-decoration="bracket"]')).toHaveLength(2),
  );
});

test("indent guides are drawn, whitespace marks only when asked, and no rulers by default", async () => {
  await openEditor("a\n  b\n    c");
  await waitFor(() => expect(document.querySelectorAll("[data-indent-guide]")).toHaveLength(2));
  expect(document.querySelectorAll("[data-whitespace]")).toHaveLength(0);
  expect(document.querySelectorAll("[data-ruler]")).toHaveLength(0);
});

test("render whitespace marks every space, and rulers sit where they are asked", async () => {
  await openEditor("a b", { renderWhitespace: true, rulers: [80] });
  await waitFor(() =>
    expect(document.querySelectorAll('[data-whitespace="space"]')).toHaveLength(1),
  );
  expect(document.querySelectorAll('[data-ruler="80"]')).toHaveLength(1);
});
