import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor, type CodeEditorProps, type EditorHandle } from "./editor.tsx";

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
