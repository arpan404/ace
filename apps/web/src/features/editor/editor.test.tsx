import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { CodeEditorProps, EditorHandle } from "./types.ts";

/*
 * The editing keys and input paths, driven through the hidden textarea the way a keyboard and
 * an IME reach it. The Wasm loads itself in test mode (see `wasm.ts`).
 */

beforeEach(() => {
  // jsdom reports no platform; every keybinding here is the macOS one.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

async function openEditor(props: Partial<CodeEditorProps> & { text: string }) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path={props.path ?? "src/example.ts"}
      label="Editor"
      commitAfter={20}
      highlightDelay={60_000}
      {...props}
    />,
  );
  const box = await screen.findByRole("textbox", { name: "example.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return { ref, box };
}

test("typing at three carets inserts at each of them", async () => {
  const { ref } = await openEditor({ text: "one\ntwo\nthree" });

  act(() => ref.current?.setSelections([caret(0, 3), caret(1, 3), caret(2, 5)]));
  await userEvent.keyboard("!");

  expect(ref.current?.text()).toBe("one!\ntwo!\nthree!");
  expect(ref.current?.selections()).toEqual([caret(0, 4), caret(1, 4), caret(2, 6)]);
});

test("a typing run undoes as one step after the idle pause", async () => {
  const { ref } = await openEditor({ text: "" });

  await userEvent.keyboard("abc");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await userEvent.keyboard("d");
  await userEvent.keyboard("{Meta>}z{/Meta}");
  expect(ref.current?.text()).toBe("abc");

  await userEvent.keyboard("{Meta>}z{/Meta}");
  expect(ref.current?.text()).toBe("");
});

test("paste normalises CRLF line endings", async () => {
  const { ref, box } = await openEditor({ text: "" });

  fireEvent.paste(box, {
    clipboardData: { getData: () => "first\r\nsecond\r\nthird" },
  });

  expect(ref.current?.text()).toBe("first\nsecond\nthird");
});

test("copy joins every selection with a newline", async () => {
  const { ref, box } = await openEditor({ text: "one\ntwo\nthree" });

  act(() =>
    ref.current?.setSelections([
      { anchor: { line: 0, column: 0 }, head: { line: 0, column: 3 } },
      { anchor: { line: 2, column: 0 }, head: { line: 2, column: 5 } },
    ]),
  );
  const copied: { text?: string } = {};
  fireEvent.copy(box, {
    clipboardData: {
      setData: (_type: string, value: string) => {
        copied.text = value;
      },
    },
  });

  expect(copied.text).toBe("one\nthree");
});

test("Cmd+D adds the next occurrence of the selected text", async () => {
  const { ref } = await openEditor({ text: "foo foo foo" });

  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 3 } }]),
  );
  await userEvent.keyboard("{Meta>}d{/Meta}");
  expect(ref.current?.selections()).toHaveLength(2);

  await userEvent.keyboard("{Meta>}d{/Meta}");
  expect(ref.current?.selections()).toHaveLength(3);
  expect(ref.current?.text()).toBe("foo foo foo");
});

test("Cmd+/ comments the selected lines and removes the comment again", async () => {
  const { ref } = await openEditor({
    text: "const a = 1;\nconst b = 2;",
    path: "src/example.ts",
  });

  await userEvent.keyboard("{Meta>}a{/Meta}");
  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("// const a = 1;\n// const b = 2;");

  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("const a = 1;\nconst b = 2;");
});

test("find highlights every match and Enter cycles through them", async () => {
  const { ref } = await openEditor({ text: "alpha beta gamma beta" });

  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await screen.findByRole("textbox", { name: "Find in file" });
  await userEvent.type(find, "beta");

  expect(await screen.findByText("1 of 2")).toBeTruthy();
  await waitFor(() => expect(document.querySelectorAll("mark[data-find-hit]")).toHaveLength(2));

  await userEvent.keyboard("{Enter}");
  expect(await screen.findByText("2 of 2")).toBeTruthy();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(await screen.findByText("1 of 2")).toBeTruthy();

  // The first match is selected, not merely highlighted.
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 0, column: 6 }, head: { line: 0, column: 10 } },
  ]);
});

test("IME composition shows its text inline and commits it once", async () => {
  const { ref, box } = await openEditor({ text: "" });

  fireEvent.compositionStart(box);
  fireEvent.compositionUpdate(box, { data: "に" });
  expect(document.querySelector("[data-composing]")?.textContent).toBe("に");

  fireEvent.compositionEnd(box, { data: "日本" });
  await waitFor(() => expect(ref.current?.text()).toBe("日本"));
  expect(document.querySelector("[data-composing]")).toBeNull();
  expect(ref.current?.text()).toBe("日本");
});

test("Backspace, Delete and Enter edit once through the keyboard", async () => {
  const { ref } = await openEditor({ text: "ab\ncd" });

  act(() => ref.current?.setSelections([caret(0, 2)]));
  await userEvent.keyboard("{Backspace}");
  expect(ref.current?.text()).toBe("a\ncd");

  act(() => ref.current?.setSelections([caret(1, 0)]));
  await userEvent.keyboard("{Delete}");
  expect(ref.current?.text()).toBe("a\nd");

  act(() => ref.current?.setSelections([caret(1, 1)]));
  await userEvent.keyboard("{Enter}");
  expect(ref.current?.text()).toBe("a\nd\n");
});

test("word delete removes the word before and after the caret", async () => {
  const { ref } = await openEditor({ text: "one two three" });

  act(() => ref.current?.setSelections([caret(0, 13)]));
  await userEvent.keyboard("{Alt>}{Backspace}{/Alt}");
  expect(ref.current?.text()).toBe("one two ");

  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Alt>}{Delete}{/Alt}");
  expect(ref.current?.text()).toBe(" two ");
});

test("Enter on an indented line keeps its indentation", async () => {
  const { ref } = await openEditor({ text: "  indented" });

  act(() => ref.current?.setSelections([caret(0, 10)]));
  await userEvent.keyboard("{Enter}");

  expect(ref.current?.text()).toBe("  indented\n  ");
});

test("a native beforeinput delete applies once, not twice", async () => {
  const { ref, box } = await openEditor({ text: "abc" });
  act(() => ref.current?.setSelections([caret(0, 3)]));

  act(() => {
    box.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  expect(ref.current?.text()).toBe("ab");
});

test("a read-only editor ignores cut and undo", async () => {
  const { ref, box } = await openEditor({ text: "unchanged", readOnly: true });
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 4 } }]),
  );

  fireEvent.cut(box, { clipboardData: { setData: () => undefined, getData: () => "" } });
  await userEvent.keyboard("{Meta>}z{/Meta}");

  expect(ref.current?.text()).toBe("unchanged");
});

test("IME composition is drawn at every caret", async () => {
  const { ref, box } = await openEditor({ text: "one\ntwo" });
  act(() => ref.current?.setSelections([caret(0, 3), caret(1, 3)]));

  fireEvent.compositionStart(box);
  fireEvent.compositionUpdate(box, { data: "に" });
  await waitFor(() => expect(document.querySelectorAll("[data-composing]")).toHaveLength(2));

  fireEvent.compositionEnd(box, { data: "日本" });
  await waitFor(() => expect(ref.current?.text()).toBe("one日本\ntwo日本"));
});

test("Shift+Cmd+D is not swallowed by select-next-occurrence", async () => {
  const { ref, box } = await openEditor({ text: "foo foo" });
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 3 } }]),
  );
  let reached = 0;
  const listener = () => {
    reached++;
  };
  document.addEventListener("keydown", listener);
  const notPrevented = fireEvent.keyDown(box, { key: "d", metaKey: true, shiftKey: true });
  document.removeEventListener("keydown", listener);

  expect(notPrevented).toBe(true);
  expect(reached).toBe(1);
  expect(ref.current?.selections()).toHaveLength(1);
});

test("Alt+Arrow moves a line while Alt+Cmd+Arrow leaves it alone", async () => {
  const { ref } = await openEditor({ text: "one\ntwo" });
  act(() => ref.current?.setSelections([caret(0, 1)]));

  await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
  expect(ref.current?.text()).toBe("two\none");

  await userEvent.keyboard("{Meta>}{Alt>}{ArrowUp}{/Alt}{/Meta}");
  expect(ref.current?.text()).toBe("two\none");
});

test("Cmd+Up and Cmd+Down jump to the document's start and end, and Shift extends", async () => {
  const { ref } = await openEditor({ text: "one\ntwo\nthree" });
  act(() => ref.current?.setSelections([caret(1, 1)]));

  await userEvent.keyboard("{Meta>}{ArrowDown}{/Meta}");
  expect(ref.current?.selections()).toEqual([caret(2, 5)]);

  await userEvent.keyboard("{Meta>}{ArrowUp}{/Meta}");
  expect(ref.current?.selections()).toEqual([caret(0, 0)]);

  act(() => ref.current?.setSelections([caret(1, 1)]));
  await userEvent.keyboard("{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 1, column: 1 }, head: { line: 2, column: 5 } },
  ]);
  await userEvent.keyboard("{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 1, column: 1 }, head: { line: 0, column: 0 } },
  ]);
});

test("Ctrl+Home and Ctrl+End jump to the document's start and end off macOS", async () => {
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  const { ref } = await openEditor({ text: "one\ntwo\nthree" });
  act(() => ref.current?.setSelections([caret(1, 1)]));

  await userEvent.keyboard("{Control>}{End}{/Control}");
  expect(ref.current?.selections()).toEqual([caret(2, 5)]);
  await userEvent.keyboard("{Control>}{Shift>}{Home}{/Shift}{/Control}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 2, column: 5 }, head: { line: 0, column: 0 } },
  ]);
});

test("Cmd+Alt+Down and Cmd+Alt+Up add a cursor on the line below and above", async () => {
  const { ref } = await openEditor({ text: "one\ntwo\nthree" });
  act(() => ref.current?.setSelections([caret(1, 2)]));

  await userEvent.keyboard("{Meta>}{Alt>}{ArrowDown}{/Alt}{/Meta}");
  expect(ref.current?.selections()).toEqual([caret(1, 2), caret(2, 2)]);
  await userEvent.keyboard("{Meta>}{Alt>}{ArrowUp}{/Alt}{/Meta}");
  await userEvent.keyboard("{Meta>}{Alt>}{ArrowUp}{/Alt}{/Meta}");
  const carets = ref.current?.selections() ?? [];
  expect(carets.map((one) => one.head.line).toSorted()).toEqual([0, 1, 2]);
  expect(ref.current?.text()).toBe("one\ntwo\nthree");
});

test("Ctrl+Alt+Down adds a cursor below off macOS", async () => {
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  const { ref } = await openEditor({ text: "one\ntwo" });
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await userEvent.keyboard("{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}");
  expect(ref.current?.selections()).toEqual([caret(0, 1), caret(1, 1)]);
});

test("the find bar takes its own row above the text, so it never covers the first lines", async () => {
  const { box } = await openEditor({ text: "first line\nsecond line" });

  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await screen.findByRole("textbox", { name: "Find in file" });
  const bar = find.closest("search");
  const scroller = document.querySelector("[data-editor-scroller]");
  expect(bar).toBeTruthy();
  expect(scroller).toBeTruthy();
  // Not drawn over the scroller: a sibling row above it, out of the text's own box.
  expect(bar?.className).not.toMatch(/\babsolute\b/);
  expect(bar?.contains(scroller)).toBe(false);
  expect(bar?.parentElement?.contains(box)).toBe(true);
  expect(bar?.parentElement?.contains(scroller)).toBe(true);
  const box2 = scroller?.parentElement;
  expect(box2?.contains(bar)).toBe(false);
  expect(box2?.contains(box)).toBe(true);
});

test("the find bar's field sits inside the bar and only the field shows focus", async () => {
  await openEditor({ text: "first line\nsecond line" });

  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await screen.findByRole("textbox", { name: "Find in file" });
  const bar = find.closest("search");
  const region = screen.getByRole("region", { name: "Editor" });
  expect(document.activeElement).toBe(find);
  // The field is a box inside the 36px bar, never the bar's full height: its ring stays inside.
  expect(bar?.className).toMatch(/\bh-9\b/);
  expect(find.className).toMatch(/\bh-6\b/);
  expect(find.className).not.toMatch(/\bh-full\b/);
  expect(find.className).not.toMatch(/\bfocus-ring\b/);
  // The editor's focus frame belongs to the text, not to the region that holds the bar.
  expect(region.className).not.toMatch(/focus-within/);
  const frame = document.querySelector("[data-editor-frame]");
  expect(frame?.className).toMatch(/focus-within/);
  expect(frame?.contains(bar)).toBe(false);
  expect(frame?.contains(screen.getByRole("textbox", { name: "example.ts" }))).toBe(true);
});
