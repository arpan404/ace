import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";

/*
 * With two editors side by side, only the one with the keyboard shows a live caret, and only
 * it washes the caret's line; the other keeps a still, dim caret where typing would resume.
 */

function regionOf(label: string) {
  const region = screen.getByRole("region", { name: label });
  return {
    box: region.querySelector("textarea"),
    carets: () => [...region.querySelectorAll<HTMLElement>("[data-caret]")],
    currentLine: () => region.querySelector("[data-current-line]"),
  };
}

test("only the focused editor of two shows a live caret and the current-line wash", async () => {
  render(
    <>
      <CodeEditor path="a.ts" label="Left" text="one" highlightDelay={60_000} cursorBlinking />
      <CodeEditor path="b.ts" label="Right" text="two" highlightDelay={60_000} cursorBlinking />
    </>,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await screen.findByRole("textbox", { name: "b.ts" });
  const left = regionOf("Left");
  const right = regionOf("Right");

  act(() => left.box?.focus());
  await waitFor(() => expect(left.carets()[0]?.dataset.caret).toBe("live"));
  expect(right.carets()[0]?.dataset.caret).toBe("idle");
  expect(left.currentLine()).not.toBeNull();
  expect(right.currentLine()).toBeNull();

  act(() => right.box?.focus());
  await waitFor(() => expect(right.carets()[0]?.dataset.caret).toBe("live"));
  expect(left.carets()[0]?.dataset.caret).toBe("idle");
  expect(left.currentLine()).toBeNull();
  expect(right.currentLine()).not.toBeNull();
});
