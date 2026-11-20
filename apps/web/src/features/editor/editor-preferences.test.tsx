import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { CodeEditorProps, EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const source = ["function a() {", "  if (x) {", "    y( 1 );", "  }", "}"].join("\n");

async function openEditor(props: Partial<CodeEditorProps> = {}) {
  const ref = createRef<EditorHandle>();
  const view = (more: Partial<CodeEditorProps>) => (
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={source}
      highlightDelay={60_000}
      {...props}
      {...more}
    />
  );
  const rendered = render(view({}));
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  return { ref, rerender: (more: Partial<CodeEditorProps>) => rendered.rerender(view(more)) };
}

const caret = () => document.querySelector<HTMLElement>("[data-caret]");
const rowTop = (line: number) =>
  document.querySelector<HTMLElement>(`[data-line="${line}"]`)?.style.top;

test("a larger font size and row height lay the text out on taller rows", async () => {
  const { rerender } = await openEditor();
  expect(rowTop(3)).toBe("66px");
  rerender({ fontSize: 18, lineHeight: 30, fontFamily: "Iosevka" });
  await waitFor(() => expect(rowTop(3)).toBe("90px"));
  const frame = document.querySelector<HTMLElement>("[data-editor-frame]");
  expect(frame?.style.fontSize).toBe("18px");
  expect(frame?.style.fontFamily).toBe("Iosevka");
});

test("indentation guides show by default and go when turned off", async () => {
  const { rerender } = await openEditor();
  expect(document.querySelectorAll("[data-indent-guide]").length).toBeGreaterThan(0);
  rerender({ indentGuides: false });
  expect(document.querySelectorAll("[data-indent-guide]")).toHaveLength(0);
});

test("whitespace marks follow the default as it changes while the file is open", async () => {
  const { rerender } = await openEditor();
  expect(document.querySelectorAll("[data-whitespace]")).toHaveLength(0);
  rerender({ renderWhitespace: true });
  await waitFor(() =>
    expect(document.querySelectorAll("[data-whitespace]").length).toBeGreaterThan(0),
  );
  rerender({ renderWhitespace: false });
  await waitFor(() => expect(document.querySelectorAll("[data-whitespace]")).toHaveLength(0));
});

test("the caret blinks only when cursor blinking is on", async () => {
  const { ref, rerender } = await openEditor();
  act(() => ref.current?.focus());
  expect(caret()?.classList.contains("fx-caret-blink")).toBe(false);
  rerender({ cursorBlinking: true });
  expect(caret()?.classList.contains("fx-caret-blink")).toBe(true);
});
