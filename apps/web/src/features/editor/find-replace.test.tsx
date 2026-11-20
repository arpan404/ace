import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";
import { matchFrom, stepIndex } from "./use-find-in-file.ts";

/* Find and replace through the bar, the way the keyboard and the buttons reach it. */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

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

test("Replace all rewrites every match and one undo brings them back", async () => {
  const ref = await openEditor("cat dog cat\ncat");
  await userEvent.keyboard("{Meta>}{Alt>}f{/Alt}{/Meta}");
  await userEvent.type(screen.getByRole("textbox", { name: "Find in file" }), "cat");
  expect(await screen.findByText("1 of 3")).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Replace with" }), "owl");
  await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(ref.current?.text()).toBe("owl dog owl\nowl");
  expect(await screen.findByText("No results")).toBeTruthy();

  act(() => ref.current?.focus());
  await userEvent.keyboard("{Meta>}z{/Meta}");
  expect(ref.current?.text()).toBe("cat dog cat\ncat");
});

test("Enter in the replace field replaces the current match and moves to the next", async () => {
  const ref = await openEditor("a a a");
  await userEvent.keyboard("{Meta>}{Alt>}f{/Alt}{/Meta}");
  await userEvent.type(screen.getByRole("textbox", { name: "Find in file" }), "a");
  expect(await screen.findByText("1 of 3")).toBeTruthy();
  const replace = screen.getByRole("textbox", { name: "Replace with" });
  await userEvent.type(replace, "b{Enter}");
  expect(ref.current?.text()).toBe("b a a");
  expect(await screen.findByText("1 of 2")).toBeTruthy();
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 0, column: 2 }, head: { line: 0, column: 3 } },
  ]);
});

test("a regex replacement fills in its capture groups", async () => {
  const ref = await openEditor("x=1\ny=2");
  await userEvent.keyboard("{Meta>}{Alt>}f{/Alt}{/Meta}");
  const find = screen.getByRole("textbox", { name: "Find in file" });
  fireEvent.keyDown(find, { key: "®", code: "KeyR", altKey: true });
  expect(
    screen.getByRole("button", { name: "Use regular expression" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.change(find, { target: { value: "(\\w)=(\\d)" } });
  expect(await screen.findByText("1 of 2")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
    target: { value: "$2=$1" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(ref.current?.text()).toBe("1=x\n2=y");
});

test("Alt+C matches case and Alt+W whole words only", async () => {
  await openEditor("Foo foo food");
  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = screen.getByRole("textbox", { name: "Find in file" });
  await userEvent.type(find, "foo");
  expect(await screen.findByText(/of 3$/)).toBeTruthy();
  fireEvent.keyDown(find, { key: "ç", code: "KeyC", altKey: true });
  expect(await screen.findByText(/of 2$/)).toBeTruthy();
  fireEvent.keyDown(find, { key: "∑", code: "KeyW", altKey: true });
  expect(await screen.findByText("1 of 1")).toBeTruthy();
});

test("find in selection counts and replaces only inside the selection", async () => {
  const ref = await openEditor("x x\nx x\nx x");
  act(() =>
    ref.current?.setSelections([{ anchor: { line: 1, column: 0 }, head: { line: 1, column: 3 } }]),
  );
  await userEvent.keyboard("{Meta>}{Alt>}f{/Alt}{/Meta}");
  await userEvent.click(screen.getByRole("button", { name: "Find in selection" }));
  // The bar opened on the selected text; search for one letter instead.
  fireEvent.change(screen.getByRole("textbox", { name: "Find in file" }), {
    target: { value: "x" },
  });
  expect(await screen.findByText(/of 2$/)).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Replace with" }), "y");
  await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(ref.current?.text()).toBe("x x\ny y\nx x");
});

test("Cmd+G goes to the next match and Shift+Cmd+G to the previous one", async () => {
  const ref = await openEditor("ab ab ab");
  await userEvent.keyboard("{Meta>}f{/Meta}");
  await userEvent.type(screen.getByRole("textbox", { name: "Find in file" }), "ab");
  expect(await screen.findByText("1 of 3")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  // The bar is closed: Cmd+G opens it on the same query and steps.
  await userEvent.keyboard("{Meta>}g{/Meta}");
  expect(await screen.findByText("2 of 3")).toBeTruthy();
  await userEvent.keyboard("{Meta>}{Shift>}g{/Shift}{/Meta}");
  expect(await screen.findByText("1 of 3")).toBeTruthy();
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 0, column: 0 }, head: { line: 0, column: 2 } },
  ]);
});

test("stepping starts from the caret and wraps at either end", () => {
  const matches = [0, 4, 8].map((column) => ({
    start: { line: 0, column },
    end: { line: 0, column: column + 1 },
  }));
  expect(matchFrom(matches, { line: 0, column: 5 })).toBe(2);
  expect(matchFrom(matches, { line: 1, column: 0 })).toBe(0);
  expect(stepIndex(matches, -1, 1, at(5))).toBe(2);
  expect(stepIndex(matches, -1, -1, at(5))).toBe(1);
  // A selected match steps past itself.
  expect(
    stepIndex(matches, -1, 1, { start: { line: 0, column: 4 }, end: { line: 0, column: 5 } }),
  ).toBe(2);
  expect(stepIndex(matches, 2, 1, at(0))).toBe(0);
  expect(stepIndex(matches, 0, -1, at(0))).toBe(2);
});

function at(column: number) {
  return { start: { line: 0, column }, end: { line: 0, column } };
}
