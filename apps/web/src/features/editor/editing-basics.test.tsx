import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/*
 * The editing basics a modern code editor has, typed on macOS: pairs that delete together, line
 * moves and copies over selections and several carets, comments, and other occurrences of what
 * is selected.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

async function openEditor(text: string) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="src/example.ts"
      label="Editor"
      text={text}
      commitAfter={20}
      highlightDelay={60_000}
    />,
  );
  await screen.findByRole("textbox", { name: "example.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return ref;
}

test("Backspace right after typing an opener deletes it with its closer", async () => {
  const ref = await openEditor("call");
  act(() => ref.current?.setSelections([caret(0, 4)]));

  await userEvent.keyboard("(");
  expect(ref.current?.text()).toBe("call()");
  await userEvent.keyboard("{Backspace}");

  expect(ref.current?.text()).toBe("call");
});

test("Alt+Down moves every selected line down and keeps them selected", async () => {
  const ref = await openEditor("a\nb\nc\nd");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 1, column: 1 } }]),
  );

  await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");

  expect(ref.current?.text()).toBe("c\na\nb\nd");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 1, column: 0 }, head: { line: 2, column: 1 } },
  ]);
});

test("Alt+Up moves the line under each of several carets", async () => {
  const ref = await openEditor("a\nb\nc\nd");
  act(() => ref.current?.setSelections([caret(1, 0), caret(3, 0)]));

  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");

  expect(ref.current?.text()).toBe("b\na\nd\nc");
});

test("Shift+Alt+Down copies the line under each of several carets", async () => {
  const ref = await openEditor("a\nb\nc");
  act(() => ref.current?.setSelections([caret(0, 0), caret(2, 0)]));

  await userEvent.keyboard("{Shift>}{Alt>}{ArrowDown}{/Alt}{/Shift}");

  expect(ref.current?.text()).toBe("a\na\nb\nc\nc");
});

test("Cmd+/ comments the selected lines with the language's token, and again uncomments", async () => {
  const ref = await openEditor("one();\ntwo();");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 1, column: 3 } }]),
  );

  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("// one();\n// two();");

  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("one();\ntwo();");
});

test("selected text lights up its other occurrences, even inside other words", async () => {
  const ref = await openEditor("userName\nname = user");

  act(() =>
    ref.current?.setSelections([{ anchor: { line: 1, column: 7 }, head: { line: 1, column: 11 } }]),
  );

  await waitFor(() =>
    expect(document.querySelectorAll('[data-decoration="occurrence"]')).toHaveLength(2),
  );
});
