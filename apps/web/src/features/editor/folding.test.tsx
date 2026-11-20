import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { allFolds, foldAround, foldAt, hiddenRanges, isFoldStart } from "./folding.ts";
import type { EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const source = ["fn a() {", "  if x {", "    y();", "", "  }", "}", "z"];
const at = (lines: string[]) => (line: number) => lines[line] ?? "";

test("a region starts where the next line with text is deeper and ends before the closer", () => {
  expect(isFoldStart(at(source), 7, 0, 2)).toBe(true);
  expect(isFoldStart(at(source), 7, 2, 2)).toBe(false);
  expect(foldAt(at(source), 7, 0, 2)).toEqual({ start: 0, end: 4 });
  // A blank line after the last deeper line stays outside the region.
  expect(foldAt(at(source), 7, 1, 2)).toEqual({ start: 1, end: 2 });
  expect(foldAt(at(source), 7, 6, 2)).toBeUndefined();
});

test("the region around a line is the innermost one holding it", () => {
  expect(foldAround(at(source), 7, 2, 2)).toEqual({ start: 1, end: 2 });
  expect(foldAround(at(source), 7, 4, 2)).toEqual({ start: 0, end: 4 });
  expect(foldAround(at(source), 7, 6, 2)).toBeUndefined();
});

test("every region is listed in one pass, nested ones too", () => {
  expect(allFolds(at(source), 7, 2)).toEqual([
    { start: 0, end: 4 },
    { start: 1, end: 2 },
  ]);
});

test("nested folds hide one merged range", () => {
  expect(
    hiddenRanges([
      { start: 1, end: 3 },
      { start: 0, end: 4 },
    ]),
  ).toEqual([{ from: 1, to: 5 }]);
});

async function openEditor(text: string) {
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
  return ref;
}

const drawn = () =>
  [...document.querySelectorAll("[data-line-number]")].map((one) =>
    one.getAttribute("data-line-number"),
  );

test("Cmd+Alt+[ folds the region at the caret and Cmd+Alt+] opens it", async () => {
  const ref = await openEditor(source.join("\n"));
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 2, column: 2 }, head: { line: 2, column: 2 } }]),
  );
  await userEvent.keyboard("{Meta>}{Alt>}[[{/Alt}{/Meta}");
  expect(drawn()).toEqual(["1", "2", "4", "5", "6", "7"]);
  expect(document.querySelector('[data-fold="closed"]')).toBeTruthy();
  // The caret on a hidden line moved to the end of the fold's header.
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 1, column: 8 }, head: { line: 1, column: 8 } },
  ]);
  await userEvent.keyboard("{Meta>}{Alt>}]{/Alt}{/Meta}");
  expect(drawn()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
});

test("Cmd+K Cmd+0 folds everything and Cmd+K Cmd+J opens everything", async () => {
  await openEditor(source.join("\n"));
  await userEvent.keyboard("{Meta>}k{/Meta}{Meta>}0{/Meta}");
  expect(drawn()).toEqual(["1", "6", "7"]);
  await userEvent.keyboard("{Meta>}k{/Meta}{Meta>}j{/Meta}");
  expect(drawn()).toHaveLength(7);
});

test("a click on a line's fold control in the gutter folds and opens it", async () => {
  await openEditor(source.join("\n"));
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  fireEvent.pointerDown(scroller, { button: 0, clientX: 4, clientY: 5 });
  expect(drawn()).toEqual(["1", "6", "7"]);
  fireEvent.pointerDown(scroller, { button: 0, clientX: 4, clientY: 5 });
  expect(drawn()).toHaveLength(7);
});

test("typing above a fold keeps it closed", async () => {
  const ref = await openEditor(["top", ...source].join("\n"));
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 2, column: 0 }, head: { line: 2, column: 0 } }]),
  );
  await userEvent.keyboard("{Meta>}{Alt>}[[{/Alt}{/Meta}");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 3 }, head: { line: 0, column: 3 } }]),
  );
  await userEvent.keyboard("{Enter}");
  expect(drawn()).toEqual(["1", "2", "3", "4", "6", "7", "8", "9"]);
});

test("after Fold All, Enter on a folded header opens that fold alone; its nested fold and the rest stay closed", async () => {
  const text = ["fn a() {", "  if x {", "    y();", "  }", "}", "fn b() {", "  z();", "}"];
  const ref = await openEditor(text.join("\n"));
  await userEvent.keyboard("{Meta>}k{/Meta}{Meta>}0{/Meta}");
  expect(drawn()).toEqual(["1", "5", "6", "8"]);
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 8 }, head: { line: 0, column: 8 } }]),
  );
  await userEvent.keyboard("{Enter}");
  expect(drawn()).toEqual(["1", "2", "3", "5", "6", "7", "9"]);
});
