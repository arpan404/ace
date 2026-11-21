import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/*
 * Find floats over the code's top right instead of pushing the text down: it lives inside the
 * code's frame, the scroller keeps its place, and replace waits behind its toggle.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

test("Cmd+F floats find over the code, leaves the text in place and folds replace away", async () => {
  const ref = createRef<EditorHandle>();
  render(<CodeEditor ref={ref} path="a.ts" label="Editor" text="one two" highlightDelay={60_000} />);
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  const frame = document.querySelector("[data-editor-frame]");
  const scroller = document.querySelector("[data-editor-scroller]");
  const before = [...(frame?.parentElement?.children ?? [])];

  await userEvent.keyboard("{Meta>}f{/Meta}");

  const find = await screen.findByRole("search");
  expect(frame?.contains(find)).toBe(true);
  expect([...(frame?.parentElement?.children ?? [])]).toEqual(before);
  expect(scroller?.parentElement).toBe(frame);
  expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
  expect(screen.getByRole("textbox", { name: "Replace with" })).toBeTruthy();
});
