import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/* Smart typing through the hidden textarea: pairs, Enter's indent, Backspace, detected indent. */

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
      path="a.ts"
      label="Editor"
      text={text}
      commitAfter={20}
      highlightDelay={60_000}
    />,
  );
  const box = await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return { ref, box };
}

test("typing a bracket closes it, and typing the closer steps over it", async () => {
  const { ref } = await openEditor("");
  await userEvent.keyboard("f(x");
  expect(ref.current?.text()).toBe("f(x)");
  await userEvent.keyboard(")");
  expect(ref.current?.text()).toBe("f(x)");
  expect(ref.current?.selections()).toEqual([caret(0, 4)]);
});

test("a quote over a selection wraps it", async () => {
  const { ref } = await openEditor("name");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 4 } }]),
  );
  await userEvent.keyboard('"');
  expect(ref.current?.text()).toBe('"name"');
});

test("a paste with brackets goes in as it is", async () => {
  const { ref, box } = await openEditor("");
  fireEvent.paste(box, { clipboardData: { getData: () => "(" } });
  expect(ref.current?.text()).toBe("(");
});

test("Enter between braces opens an indented line with the closer below", async () => {
  const { ref } = await openEditor("");
  await userEvent.keyboard("{{");
  await userEvent.keyboard("{Enter}");
  expect(ref.current?.text()).toBe("{\n  \n}");
  expect(ref.current?.selections()).toEqual([caret(1, 2)]);
});

test("a file indented with four spaces gets four-space steps, and Backspace removes one", async () => {
  const { ref } = await openEditor("a\n    b\n");
  act(() => ref.current?.setSelections([caret(2, 0)]));
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).toBe("a\n    b\n    ");
  await userEvent.keyboard("{Backspace}");
  expect(ref.current?.text()).toBe("a\n    b\n");
});

test("a file indented with tabs gets tabs", async () => {
  const { ref } = await openEditor("a\n\tb\n");
  act(() => ref.current?.setSelections([caret(2, 0)]));
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).toBe("a\n\tb\n\t");
});
