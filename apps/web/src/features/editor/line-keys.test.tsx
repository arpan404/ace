import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/* VS Code's line keys, typed into the editor on macOS (and Ctrl elsewhere where it differs). */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

async function openEditor(text: string, path = "src/example.ts") {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path={path}
      label="Editor"
      text={text}
      commitAfter={20}
      highlightDelay={60_000}
    />,
  );
  await screen.findByRole("textbox", { name: path.slice(path.lastIndexOf("/") + 1) });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return ref;
}

test("Shift+Alt+Up copies the line above and keeps the caret on the upper copy", async () => {
  const ref = await openEditor("a\nb");
  act(() => ref.current?.setSelections([caret(1, 1)]));
  await userEvent.keyboard("{Shift>}{Alt>}{ArrowUp}{/Alt}{/Shift}");
  expect(ref.current?.text()).toBe("a\nb\nb");
  expect(ref.current?.selections()).toEqual([caret(1, 1)]);
});

test("Shift+Cmd+K deletes the line", async () => {
  const ref = await openEditor("one\ntwo\nthree");
  act(() => ref.current?.setSelections([caret(1, 1)]));
  await userEvent.keyboard("{Shift>}{Meta>}k{/Meta}{/Shift}");
  expect(ref.current?.text()).toBe("one\nthree");
});

test("Cmd+Enter opens a line below and Shift+Cmd+Enter one above", async () => {
  const ref = await openEditor("  x");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  expect(ref.current?.text()).toBe("  x\n  ");
  await userEvent.keyboard("{Shift>}{Meta>}{Enter}{/Meta}{/Shift}");
  expect(ref.current?.text()).toBe("  x\n  \n  ");
  expect(ref.current?.selections()).toEqual([caret(1, 2)]);
});

test("Tab at a caret inserts an indent there; over lines it indents them; Shift+Tab undoes it", async () => {
  const ref = await openEditor("ab\ncd");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).toBe("a b\ncd");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 1, column: 1 } }]),
  );
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).toBe("  a b\n  cd");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(ref.current?.text()).toBe("a b\ncd");
});

test("Cmd+] and Cmd+[ indent and outdent the line wherever the caret is", async () => {
  const ref = await openEditor("ab");
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await userEvent.keyboard("{Meta>}]{/Meta}");
  expect(ref.current?.text()).toBe("  ab");
  await userEvent.keyboard("{Meta>}[[{/Meta}");
  expect(ref.current?.text()).toBe("ab");
});

test("Ctrl+J joins the line with the next one", async () => {
  const ref = await openEditor("a\n   b");
  await userEvent.keyboard("{Control>}j{/Control}");
  expect(ref.current?.text()).toBe("a b");
});

test("Cmd+L selects the line, and again takes the next one", async () => {
  const ref = await openEditor("a\nb\nc");
  await userEvent.keyboard("{Meta>}l{/Meta}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 0, column: 0 }, head: { line: 1, column: 0 } },
  ]);
  await userEvent.keyboard("{Meta>}l{/Meta}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 0, column: 0 }, head: { line: 2, column: 0 } },
  ]);
});

test("Shift+Alt+A wraps the selection in the language's block comment", async () => {
  const ref = await openEditor("f(a)");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 2 }, head: { line: 0, column: 3 } }]),
  );
  await userEvent.keyboard("{Shift>}{Alt>}a{/Alt}{/Shift}");
  expect(ref.current?.text()).toBe("f(/* a */)");
});

test("Cmd+/ in CSS, which has no line comment, comments the line with a block", async () => {
  const ref = await openEditor("  a { color: red; }", "styles/site.css");
  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("  /* a { color: red; } */");
  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("  a { color: red; }");
});

test("Cmd+/ uses # in Python", async () => {
  const ref = await openEditor("x = 1", "main.py");
  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("# x = 1");
});

test("Ctrl+Shift+K deletes the line off macOS", async () => {
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  const ref = await openEditor("one\ntwo");
  await userEvent.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
  expect(ref.current?.text()).toBe("two");
});
