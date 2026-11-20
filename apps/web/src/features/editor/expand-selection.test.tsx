import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

async function openEditor(text: string) {
  const ref = createRef<EditorHandle>();
  render(<CodeEditor ref={ref} path="a.ts" label="Editor" text={text} highlightDelay={60_000} />);
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return ref;
}

const span = (from: number, to: number) => ({
  anchor: { line: 0, column: from },
  head: { line: 0, column: to },
});

test("Ctrl+Shift+Cmd+Right grows the selection and Ctrl+Shift+Cmd+Left walks it back", async () => {
  const ref = await openEditor("f(alpha, beta)");
  act(() => ref.current?.setSelections([span(4, 4)]));
  const grow = "{Control>}{Shift>}{Meta>}{ArrowRight}{/Meta}{/Shift}{/Control}";
  const shrink = "{Control>}{Shift>}{Meta>}{ArrowLeft}{/Meta}{/Shift}{/Control}";
  await userEvent.keyboard(grow);
  expect(ref.current?.selections()).toEqual([span(2, 7)]);
  await userEvent.keyboard(grow);
  expect(ref.current?.selections()).toEqual([span(2, 13)]);
  await userEvent.keyboard(grow);
  expect(ref.current?.selections()).toEqual([span(1, 14)]);
  await userEvent.keyboard(shrink);
  expect(ref.current?.selections()).toEqual([span(2, 13)]);
  await userEvent.keyboard(shrink);
  await userEvent.keyboard(shrink);
  expect(ref.current?.selections()).toEqual([span(4, 4)]);
});

test("Shift+Alt+Right expands off macOS", async () => {
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  const ref = await openEditor("one two");
  act(() => ref.current?.setSelections([span(1, 1)]));
  await userEvent.keyboard("{Shift>}{Alt>}{ArrowRight}{/Alt}{/Shift}");
  expect(ref.current?.selections()).toEqual([span(0, 3)]);
});
