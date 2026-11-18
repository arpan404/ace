import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { fallbackCharWidth, gutterWidth } from "./geometry.ts";
import type { CodeEditorProps, EditorHandle } from "./types.ts";
import { wrapLine } from "./wrap.ts";

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

/** The row a line starts at, once every line above it has been measured. */
const rowStart = (lines: readonly string[], line: number) =>
  lines.slice(0, line).reduce((rows, one) => rows + wrapLine(one, columns).length, 0);

/** The text one drawn row holds. */
const rowText = (row: number) =>
  document.querySelector<HTMLElement>(`[data-row="${row}"] [data-row-text]`)?.textContent;

/** The content box inside the scroller; its height is the list's whole height. */
const scrollerHost = () => document.querySelector<HTMLElement>("[data-editor-scroller] > div");

/** The primary caret's drawn row, as its top offset in pixels. */
const caretTop = () => document.querySelector<HTMLElement>("[data-caret]")?.style.top;

/** CJK text is two cells a character, so a hard break comes at this many characters. */
const cjkRow = Math.floor(columns / 2);

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

test("two carets at hard breaks are each drawn on the row before the break", async () => {
  const text = `${"中".repeat(240)}\n${"中".repeat(240)}`;
  const { ref } = await openView({ text, wrap: true });
  act(() => ref.current?.setSelections([caret(0, 0), caret(1, 0)]));

  await userEvent.keyboard("{End}");
  expect(ref.current?.selections()).toEqual([caret(0, cjkRow), caret(1, cjkRow)]);
  // The primary sits at the end of line 0's first row; the secondary at line 1's first row,
  // one row before where the same column would land without its own side of the break.
  const tops = [...document.querySelectorAll<HTMLElement>("[data-caret]")].map(
    (box) => box.style.top,
  );
  expect(tops).toEqual(["0px", `${4 * 22}px`]);
});

test("revealing a caret at a hard break scrolls to the side the move asked for", async () => {
  const { ref } = await openView({ text: "中".repeat(240), wrap: true });
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  act(() => ref.current?.setSelections([caret(0, 0)]));
  // The second row is at the top edge, so the caret's own side decides whether to scroll at all.
  scroller.scrollTop = 22;
  fireEvent.scroll(scroller);

  const scrollTo = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => undefined);
  try {
    await userEvent.keyboard("{End}");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0 });
  } finally {
    scrollTo.mockRestore();
  }
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

test("End stops at a hard break's row end and the caret is drawn there", async () => {
  const { ref } = await openView({ text: "中".repeat(240), wrap: true });
  act(() => ref.current?.setSelections([caret(0, 0)]));

  await userEvent.keyboard("{End}");
  expect(ref.current?.selections()).toEqual([caret(0, cjkRow)]);
  expect(caretTop()).toBe("0px");

  await userEvent.keyboard("{End}");
  expect(ref.current?.selections()).toEqual([caret(0, cjkRow * 2)]);
  expect(caretTop()).toBe("22px");
});

test("Down from a row's end moves one row and never skips the row it begins", async () => {
  const { ref } = await openView({ text: "中".repeat(240), wrap: true });
  act(() => ref.current?.setSelections([caret(0, 0)]));

  await userEvent.keyboard("{End}");
  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()).toEqual([caret(0, cjkRow * 2)]);
  expect(caretTop()).toBe("22px");

  await userEvent.keyboard("{ArrowDown}");
  expect(ref.current?.selections()).toEqual([caret(0, cjkRow * 3)]);
  expect(caretTop()).toBe("44px");
});

test("a click past a row's end stays on that row, drawn at its end", async () => {
  const { ref } = await openView({ text: "中".repeat(240), wrap: true });
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");

  fireEvent.pointerDown(scroller, {
    button: 0,
    clientX: gutterWidth(1) + 200 * cell,
    clientY: 5,
  });

  expect(ref.current?.selections()).toEqual([caret(0, cjkRow)]);
  expect(caretTop()).toBe("0px");
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

test("turning wrap off and on keeps the caret's logical position and redraws it", async () => {
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
  // Column 200 is on the line's second visual row once it wraps.
  act(() => ref.current?.setSelections([caret(0, 200)]));
  expect(caretTop()).toBe("0px");
  const box = screen.getByRole("textbox");
  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });

  await waitFor(() => expect(rowTexts()).toHaveLength(3));
  expect(caretTop()).toBe("22px");
  expect(ref.current?.selections()).toEqual([caret(0, 200)]);

  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });
  await waitFor(() => expect(rowTexts()).toHaveLength(1));
  expect(caretTop()).toBe("0px");
  expect(ref.current?.selections()).toEqual([caret(0, 200)]);
});

test("Alt+Z asks for wrap to toggle by its physical key on macOS", async () => {
  let toggles = 0;
  const { box } = await openView({
    text: "one two",
    wrap: false,
    onToggleWrap: () => {
      toggles++;
    },
  });

  // Option+Z reports Ω as the character on macOS; the key is what the shortcut matches.
  const notPrevented = fireEvent.keyDown(box, { key: "Ω", code: "KeyZ", altKey: true });
  expect(toggles).toBe(1);
  expect(notPrevented).toBe(false);
});

test("Alt+Z elsewhere is the letter, whatever its code", async () => {
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  let toggles = 0;
  const { box } = await openView({
    text: "one two",
    wrap: false,
    onToggleWrap: () => {
      toggles++;
    },
  });

  fireEvent.keyDown(box, { key: "z", code: "Unidentified", altKey: true });
  expect(toggles).toBe(1);
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

test("a selection that ends at a row's start leaves a sliver on the caret's row only", async () => {
  const text = `${"x".repeat(120)}  ${"y".repeat(50)}`;
  const { ref } = await openView({ text, wrap: true });
  act(() =>
    ref.current?.setSelections([
      { anchor: { line: 0, column: 0 }, head: { line: 0, column: 122 } },
    ]),
  );

  const boxes = [...document.querySelectorAll<HTMLElement>("[data-selection]")];
  // Row 0 holds the spaces the break kept; row 1 is the caret's own row, left as a sliver.
  expect(boxes.map((box) => box.style.width)).toEqual([`${122 * cell}px`, "2px"]);
  expect(boxes.map((box) => box.style.top)).toEqual(["0px", "22px"]);
});

test("the idle slices of a re-wrap keep the top line at the top", async () => {
  const width = window.innerWidth;
  const text = Array.from({ length: 5_000 }, () => `${"z".repeat(199)}e`).join("\n");
  await openView({ text, wrap: true, readOnly: true });
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  await waitFor(() => expect(scrollerHost()?.style.height).toBe(`${10_000 * 22}px`), {
    timeout: 10_000,
  });

  // Line 4,000 is at row 8,000; at 512px the same lines wrap to four rows each.
  scroller.scrollTop = 8_000 * 22;
  fireEvent.scroll(scroller);
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 512 });
    fireEvent(window, new Event("resize"));
    await waitFor(
      () => {
        expect(scrollerHost()?.style.height).toBe(`${20_000 * 22}px`);
        expect(scroller.scrollTop).toBe(16_000 * 22);
      },
      { timeout: 10_000 },
    );
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});

test("a newline above the view keeps the same text at the top, and undoing it puts it back", async () => {
  const text = Array.from({ length: 200 }, (_, at) => `line ${at} `.padEnd(300, "x")).join("\n");
  const { ref } = await openView({ text, wrap: true });
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  await waitFor(() => expect(document.querySelector('[data-line="1"]')).toBeTruthy());

  const lines = text.split("\n");
  const top = 50;
  const start = rowStart(lines, top);
  scroller.scrollTop = start * 22 + 11;
  fireEvent.scroll(scroller);
  expect(rowText(start)).toBe(`line ${top} `);

  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Enter}");

  // The line that was on top is now numbered 51; the view keeps its text and its offset in it.
  const after = ["", ...lines];
  const moved = rowStart(after, top + 1);
  await waitFor(() => expect(scroller.scrollTop).toBe(moved * 22 + 11));
  expect(
    document.querySelector<HTMLElement>(`[data-row="${moved}"]`)?.getAttribute("data-line"),
  ).toBe(String(top + 1));
  expect(rowText(moved)).toBe(`line ${top} `);

  await userEvent.keyboard("{Meta>}z{/Meta}");
  await waitFor(() => expect(scroller.scrollTop).toBe(start * 22 + 11));
  expect(rowText(start)).toBe(`line ${top} `);
});

test("toggling wrap in the middle of a line keeps that line at the top", async () => {
  const ref = createRef<EditorHandle>();
  const text = Array.from({ length: 200 }, (_, at) => `line ${at} `.padEnd(300, "x")).join("\n");
  function Wrapped() {
    const [wrap, setWrap] = useState(true);
    return (
      <CodeEditor
        ref={ref}
        text={text}
        path="notes.txt"
        label="Editor"
        highlightDelay={60_000}
        wrap={wrap}
        onToggleWrap={() => setWrap((value) => !value)}
      />
    );
  }
  render(<Wrapped />);
  const box = await screen.findByRole("textbox");
  await waitFor(() => expect(ref.current).toBeTruthy());
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  await waitFor(() => expect(document.querySelector('[data-line="1"]')).toBeTruthy());
  act(() => ref.current?.focus());

  // Line 50's second visual row is at the top edge.
  const lines = text.split("\n");
  const start = lines.slice(0, 50).reduce((rows, one) => rows + wrapLine(one, columns).length, 0);
  scroller.scrollTop = (start + 1) * 22;
  fireEvent.scroll(scroller);
  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });

  await waitFor(() => expect(scroller.scrollTop).toBe(50 * 22));
  expect(document.querySelector<HTMLElement>('[data-row="50"]')?.getAttribute("data-line")).toBe(
    "50",
  );
  expect(
    document.querySelector<HTMLElement>('[data-row="50"] [data-row-text]')?.textContent,
  ).toContain("line 50 ");
});

test("Alt+Z keeps the line at the top when the file re-wraps around it", async () => {
  const ref = createRef<EditorHandle>();
  function Wrapped() {
    const [wrap, setWrap] = useState(false);
    return (
      <CodeEditor
        ref={ref}
        text={Array.from({ length: 20_001 }, () => `${"z".repeat(199)}e`).join("\n")}
        path="notes.txt"
        label="Editor"
        highlightDelay={60_000}
        wrap={wrap}
        onToggleWrap={() => setWrap((value) => !value)}
      />
    );
  }
  render(<Wrapped />);
  const box = await screen.findByRole("textbox");
  await waitFor(() => expect(ref.current).toBeTruthy());
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("Missing the editor's scroller");
  scroller.scrollTop = 20_000 * 22;
  fireEvent.scroll(scroller);
  act(() => ref.current?.focus());

  fireEvent.keyDown(box, { key: "z", code: "KeyZ", altKey: true });

  await waitFor(() => expect(scroller.scrollTop).toBe(40_000 * 22), { timeout: 12_000 });
  expect(document.querySelector('[data-row="40000"]')?.getAttribute("data-line")).toBe("20000");
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

test("an edit above the view keeps every line where its own rows put it", async () => {
  // Every other line fills three visual rows: one line inserted above the rest moves the row
  // counts of every line below it, so a count measured for the wrong line shows as a gap.
  const lines = Array.from({ length: 300 }, (_, at) => "x".repeat(at % 2 ? 100 : 300));
  const { ref } = await openView({ text: lines.join("\n"), wrap: true });
  await waitFor(() => expect(rowTexts()[0]).toHaveLength(columns));

  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(rowTexts()[0]).toBe(""));

  const after = ["", ...lines];
  const top = (line: number) =>
    after.slice(0, line).reduce((rows, text) => rows + wrapLine(text, columns).length, 0);
  for (let line = 0; line < 6; line++) {
    expect(document.querySelector<HTMLElement>(`[data-line="${line}"]`)?.style.top).toBe(
      `${top(line) * 22}px`,
    );
  }
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
