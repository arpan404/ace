import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openThread, select } from "./test/annotate-thread.tsx";

/*
 * Annotating code in the editor, driven as a person does: select code (or press line numbers),
 * pick Annotate from the bar under the selection, ⌘⇧A or the context menu, write the comment,
 * and find it waiting in the thread's composer.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const source = [
  "export function total(items: Item[]) {",
  "  let sum = 0;",
  "  for (const item of items) sum += item.price;",
  "  return sum;",
  "}",
].join("\n");

const chip = () => screen.queryByRole("button", { name: /^Show \d+ annotations?$/ });
const scroller = () => {
  const element = document.querySelector<HTMLElement>("[data-editor-scroller]");
  if (!element) throw new Error("No editor");
  return element;
};

test("a selection shows Annotate under it, and its comment waits in the thread's composer", async () => {
  const { editor } = await openThread([{ path: "src/total.ts", text: source }]);
  expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();

  select(editor(), [1, 2], [2, 45]);
  const bar = await screen.findByRole("toolbar", { name: "Annotate selection" });
  await userEvent.click(within(bar).getByRole("button", { name: "Annotate" }));

  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  expect(within(popover).getByText("2–3")).toBeTruthy();
  await userEvent.type(within(popover).getByRole("textbox", { name: "Comment" }), "Use reduce");
  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(chip()?.textContent).toBe("1 annotation");
  // The selection gave way to a caret, so the bar is gone with it.
  expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
});

test("⌘⇧A annotates the caret's line when nothing is selected, and Escape leaves nothing behind", async () => {
  const { editor } = await openThread([{ path: "src/total.ts", text: source }]);
  select(editor(), [3, 4], [3, 4]);
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  expect(within(popover).getByText("4")).toBeTruthy();
  // ⌘⇧A is the annotation's, not select all's.
  expect(editor().selections()).toEqual([
    { anchor: { line: 3, column: 4 }, head: { line: 3, column: 4 } },
  ]);

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(chip()).toBeNull();
});

test("a note needs words; Save stays off until there are some", async () => {
  const { editor } = await openThread([{ path: "src/total.ts", text: source }]);
  select(editor(), [0, 0], [0, 6]);
  await userEvent.keyboard("{Meta>}{Shift>}a{/Shift}{/Meta}");
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  const save = within(popover).getByRole("button", { name: "Save" });
  expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(true);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "New annotation" })).toBeTruthy();
});

test("pressing line numbers selects those lines, Shift extends to a range", async () => {
  const { editor } = await openThread([{ path: "src/total.ts", text: source }]);
  // jsdom lays nothing out: rows sit 22px apart from the top, the gutter from the left.
  fireEvent.pointerDown(scroller(), { button: 0, clientX: 6, clientY: 22 * 1 + 5 });
  expect(editor().selections()).toEqual([
    { anchor: { line: 1, column: 0 }, head: { line: 2, column: 0 } },
  ]);
  fireEvent.pointerUp(scroller());
  fireEvent.pointerDown(scroller(), { button: 0, clientX: 6, clientY: 22 * 3 + 5, shiftKey: true });
  fireEvent.pointerUp(scroller());
  expect(editor().selections()).toEqual([
    { anchor: { line: 1, column: 0 }, head: { line: 4, column: 0 } },
  ]);

  const bar = await screen.findByRole("toolbar", { name: "Annotate selection" });
  await userEvent.click(within(bar).getByRole("button", { name: "Annotate" }));
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  // A whole-line selection ends at the next line's start: it covers lines 2 to 4.
  expect(within(popover).getByText("2–4")).toBeTruthy();
});

test("the context menu annotates the selection", async () => {
  const { editor } = await openThread([{ path: "src/total.ts", text: source }]);
  select(editor(), [2, 2], [2, 5]);
  fireEvent.contextMenu(scroller(), { clientX: 120, clientY: 50 });
  const menu = await screen.findByRole("menu");
  // Annotate shows its shortcut beside it.
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent?.replace(/^Annotate.+$/, "Annotate"))).toEqual([
    "Annotate",
    "Ask about this",
    "Fix this",
    "Explain",
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: /^Annotate/ }));
  const popover = await screen.findByRole("dialog", { name: "New annotation" });
  expect(within(popover).getByText("3")).toBeTruthy();
});

test("without the thread's composer there is nowhere to annotate: no bar, no menu", async () => {
  const { render } = await import("@testing-library/react");
  const { CodeEditor } = await import("./editor.tsx");
  const { useEditorAnnotations } = await import("./annotate.tsx");
  function Lone() {
    const layer = useEditorAnnotations({ threadId: undefined, path: "src/total.ts" });
    return <CodeEditor path="src/total.ts" label="Editor" text={source} layer={layer} />;
  }
  render(<Lone />);
  await screen.findByRole("textbox", { name: "total.ts" });
  fireEvent.contextMenu(scroller(), { clientX: 10, clientY: 10 });
  expect(screen.queryByRole("menu")).toBeNull();
});
