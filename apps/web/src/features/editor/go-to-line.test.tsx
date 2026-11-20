import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { parseGoTo } from "./go-to-line.tsx";
import type { EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function length(line: number): number {
  return [3, 10, 0][line] ?? 0;
}

test("line[:column] names a 1-based place, clamped to the document", () => {
  expect(parseGoTo("2", 3, length)).toEqual({ line: 1, column: 0 });
  expect(parseGoTo("2:5", 3, length)).toEqual({ line: 1, column: 4 });
  expect(parseGoTo(" 2 , 5 ", 3, length)).toEqual({ line: 1, column: 4 });
  expect(parseGoTo("99", 3, length)).toEqual({ line: 2, column: 0 });
  expect(parseGoTo("1:99", 3, length)).toEqual({ line: 0, column: 3 });
  expect(parseGoTo("0", 3, length)).toEqual({ line: 0, column: 0 });
  expect(parseGoTo("abc", 3, length)).toBeUndefined();
  expect(parseGoTo("", 3, length)).toBeUndefined();
});

test("Ctrl+G moves the caret to the line and column typed, then hands the keys back", async () => {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={"one\ntwo\nthree"}
      highlightDelay={60_000}
    />,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());

  await userEvent.keyboard("{Control>}g{/Control}");
  const field = screen.getByRole("textbox", { name: "Go to line" });
  await userEvent.type(field, "3:2{Enter}");
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 2, column: 1 }, head: { line: 2, column: 1 } },
  ]);
  expect(screen.queryByRole("textbox", { name: "Go to line" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "a.ts" }));
});
