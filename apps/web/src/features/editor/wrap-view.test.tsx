import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { fallbackCharWidth, gutterWidth } from "./geometry.ts";
import type { CodeEditorProps, EditorHandle } from "./types.ts";

/*
 * Word wrap as the Files tab draws it: rows in the virtual list, the gutter on a line's first
 * row, the caret, the pointer, the keys and find mapped through the rows. jsdom has no layout,
 * so the editor measures the fallback cell and the window's own width.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const cell = fallbackCharWidth;
/** A 1024px window leaves the text column this many cells, as the editor measures it. */
const columns = Math.floor((1024 - gutterWidth(1) - 24) / cell);

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

const rowTexts = () =>
  [...document.querySelectorAll<HTMLElement>("[data-row]")].map(
    (row) => row.querySelector<HTMLElement>("[data-row-text]")?.textContent ?? "",
  );

/** The content box inside the scroller; its height is the list's whole height. */
const scrollerHost = () => document.querySelector<HTMLElement>("[data-editor-scroller] > div");

async function openView(props: Partial<CodeEditorProps> & { text: string }) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path={props.path ?? "src/example.txt"}
      label="Editor"
      highlightDelay={60_000}
      {...props}
    />,
  );
  const box = await screen.findByRole("textbox");
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return { ref, box };
}

test("a long line wraps into visual rows at the editor's width", async () => {
  await openView({ text: "x".repeat(300), wrap: true });

  await waitFor(() => expect(rowTexts()).toHaveLength(3));
  expect(rowTexts().map((text) => text.length)).toEqual([columns, columns, 300 - columns * 2]);
  expect(rowTexts().join("")).toBe("x".repeat(300));
});

test("caret down moves a visual row inside a wrapped line", async () => {
  const { ref } = await openView({ text: "x".repeat(300), wrap: true });
  act(() => ref.current?.setSelections([caret(0, 0)]));

  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()).toEqual([caret(0, columns)]);

  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()).toEqual([caret(0, columns * 2)]);
});

test("caret up and down across a line break follow the rows around it", async () => {
  const { ref } = await openView({ text: `${"a".repeat(300)}\nshort`, wrap: true });
  act(() => ref.current?.setSelections([caret(0, columns + 4)]));

  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()).toEqual([caret(0, columns * 2 + 4)]);

  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()[0]?.head.line).toBe(1);
  expect(ref.current?.selections()[0]?.head.column).toBe(4);
});

test("a click on a continuation row places the caret at the column under the pointer", async () => {
  const { ref } = await openView({ text: "x".repeat(300), wrap: true });
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");

  fireEvent.pointerDown(scroller, {
    button: 0,
    clientX: gutterWidth(1) + 10 * cell,
    clientY: 22 + 5,
  });

  expect(ref.current?.selections()).toEqual([caret(0, columns + 10)]);
});

test("a selection across the wrap and a caret on a continuation row draw on their own rows", async () => {
  const { ref } = await openView({ text: "x".repeat(300), wrap: true });
  act(() =>
    ref.current?.setSelections([
      { anchor: { line: 0, column: 10 }, head: { line: 0, column: 250 } },
    ]),
  );

  const boxes = [...document.querySelectorAll<HTMLElement>("[data-selection]")];
  expect(boxes).toHaveLength(3);
  expect(boxes.map((box) => box.style.top)).toEqual(["0px", "22px", "44px"]);

  act(() => ref.current?.setSelections([caret(0, 200)]));
  const caretBox = document.querySelector<HTMLElement>("[data-caret]");
  expect(caretBox?.style.top).toBe("22px");
  expect(caretBox?.style.left).toBe(`${gutterWidth(1) + (200 - columns) * cell}px`);
});

test("End and Home stop at the visual row's edge before the line's", async () => {
  const { ref } = await openView({ text: "x".repeat(300), wrap: true });
  act(() => ref.current?.setSelections([caret(0, 200)]));

  await userEvent.keyboard("{End}");
  expect(ref.current?.selections()).toEqual([caret(0, columns * 2)]);

  await userEvent.keyboard("{End}");
  expect(ref.current?.selections()).toEqual([caret(0, 300)]);

  await userEvent.keyboard("{Home}");
  expect(ref.current?.selections()).toEqual([caret(0, columns * 2)]);

  await userEvent.keyboard("{Home}");
  expect(ref.current?.selections()).toEqual([caret(0, 0)]);
});

test("the gutter numbers a line on its first row only", async () => {
  await openView({ text: `${"x".repeat(300)}\n${"y".repeat(300)}`, wrap: true });

  await waitFor(() => expect(rowTexts()).toHaveLength(6));
  const numbers = [...document.querySelectorAll("[data-line-number]")].map(
    (number) => number.textContent,
  );
  expect(numbers).toEqual(["1", "2"]);
  expect(document.querySelectorAll("[data-line]")).toHaveLength(2);
});

test("turning wrap off and on keeps the caret's logical position", async () => {
  const ref = createRef<EditorHandle>();
  function Wrapped() {
    const [wrap, setWrap] = useState(false);
    return (
      <CodeEditor
        ref={ref}
        text={"x".repeat(300)}
        path="notes.txt"
        label="Editor"
        highlightDelay={60_000}
        wrap={wrap}
        onToggleWrap={() => setWrap((value) => !value)}
      />
    );
  }
  render(<Wrapped />);
  await screen.findByRole("textbox");
  await waitFor(() => expect(ref.current).toBeTruthy());
  expect(rowTexts()).toHaveLength(1);

  act(() => ref.current?.focus());
  act(() => ref.current?.setSelections([caret(0, 50)]));
  const box = screen.getByRole("textbox");
  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });

  await waitFor(() => expect(rowTexts()).toHaveLength(3));
  expect(ref.current?.selections()).toEqual([caret(0, 50)]);

  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });
  await waitFor(() => expect(rowTexts()).toHaveLength(1));
  expect(ref.current?.selections()).toEqual([caret(0, 50)]);
});

test("Alt+Z asks for wrap to toggle", async () => {
  let toggles = 0;
  const { box } = await openView({
    text: "one two",
    wrap: false,
    onToggleWrap: () => {
      toggles++;
    },
  });

  const notPrevented = fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });
  expect(toggles).toBe(1);
  expect(notPrevented).toBe(false);
});

test("a find match on a continuation row is marked on that row", async () => {
  const text = `${"x".repeat(200)}needle${"y".repeat(50)}`;
  const { ref } = await openView({ text, wrap: true, readOnly: false });
  act(() => ref.current?.focus());

  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await screen.findByRole("textbox", { name: "Find in file" });
  await userEvent.type(find, "needle");

  const marks = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("mark[data-find-hit]")];
    expect(found).toHaveLength(1);
    return found;
  });
  const row = marks[0]?.closest<HTMLElement>("[data-row]");
  expect(row?.getAttribute("data-row")).toBe("1");
});

test("a narrower editor re-wraps the lines on screen", async () => {
  const width = window.innerWidth;
  await openView({ text: "x".repeat(300), wrap: true });
  await waitFor(() => expect(rowTexts()).toHaveLength(3));

  Object.defineProperty(window, "innerWidth", { configurable: true, value: 512 });
  fireEvent(window, new Event("resize"));

  await waitFor(() => expect(rowTexts().length).toBeGreaterThan(3));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
});

test("a width change re-wraps the whole file in the background, not only the lines on screen", async () => {
  const text = Array.from({ length: 5_000 }, (_, index) => `${"z".repeat(199)}${index % 10}`).join(
    "\n",
  );
  await openView({ text, wrap: true, readOnly: true });
  await waitFor(() => expect(scrollerHost()?.style.height).toBe(`${10_000 * 22}px`), {
    timeout: 10_000,
  });
  expect(document.querySelectorAll("[data-row]").length).toBeLessThan(200);
});

test("a 50,000-line file with wrap mounts only the rows near the view", async () => {
  const text = Array.from(
    { length: 50_000 },
    (_, index) => `line ${index} with enough words to run near the editor's own width edge`,
  ).join("\n");
  await openView({ text, wrap: true, readOnly: true });

  await waitFor(() => expect(document.querySelectorAll("[data-row]").length).toBeGreaterThan(0));
  expect(document.querySelectorAll("[data-row]").length).toBeLessThan(200);
  expect(document.querySelector('[data-line="0"]')).toBeTruthy();
  expect(document.querySelector('[data-line="49999"]')).toBeNull();
});
