import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const body = Array.from({ length: 30 }, (_, index) => `    step(${index});`);
const source = ["class Store {", "  load() {", ...body, "  }", "}", "done();"].join("\n");

async function openEditor(stickyScroll?: boolean) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={source}
      highlightDelay={60_000}
      {...(stickyScroll === undefined ? {} : { stickyScroll })}
    />,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  return ref;
}

const scrollTo = (row: number) => {
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!scroller) throw new Error("no scroller");
  scroller.scrollTop = row * 22;
  fireEvent.scroll(scroller);
};

const pinned = () => {
  const region = screen.queryByRole("group", { name: "Current scope" });
  return region
    ? within(region)
        .getAllByRole("button")
        .map((button) => button.textContent)
    : [];
};

test("scrolled into a method, its class and its own header stay pinned at the top", async () => {
  await openEditor();
  expect(pinned()).toEqual([]);
  scrollTo(12);
  await waitFor(() => expect(pinned()).toEqual(["1class Store {", "2  load() {"]));
  // Back above the method: nothing to pin.
  scrollTo(0);
  await waitFor(() => expect(pinned()).toEqual([]));
});

test("clicking a pinned header puts the caret on it", async () => {
  const ref = await openEditor();
  scrollTo(12);
  const region = await screen.findByRole("group", { name: "Current scope" });
  await userEvent.click(within(region).getByRole("button", { name: /load\(\)/ }));
  expect(ref.current?.selections()).toEqual([
    { anchor: { line: 1, column: 2 }, head: { line: 1, column: 2 } },
  ]);
});

test("with sticky scroll off nothing is pinned", async () => {
  await openEditor(false);
  scrollTo(12);
  await act(async () => {});
  expect(pinned()).toEqual([]);
});
