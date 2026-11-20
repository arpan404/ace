import { groupsOf } from "@ace/ui-core/editor-workbench";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vitest";
import {
  allowDragEvents,
  editorArea,
  one,
  region,
  strip,
  tabNames,
  transfer,
  two,
} from "./editor-test-dom.ts";
import { settle } from "../buffers/test-support.ts";
import { mountEditor, tab } from "./editor-test-support.tsx";
import type { EditorStatus } from "@/features/editor";

/*
 * The editor's strips and groups through the rendered view, on W1's model and a real registry:
 * drags, splits, slots, closing, resizing and group keys.
 */

beforeAll(allowDragEvents);

test("dragging a tab to a group's right third makes a new group holding it", async () => {
  const editor = await mountEditor(one());
  const area = editorArea(1);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 280, clientY: 150 });
  fireEvent.drop(area, { dataTransfer: data, clientX: 280, clientY: 150 });

  expect(tabNames(1)).toEqual(["a.ts"]);
  expect(tabNames(2)).toEqual(["b.ts"]);
  expect(editor.seen.at(-1)?.root).toMatchObject({ kind: "split", direction: "row" });
});

test("dropping a tab on another group's strip moves it there at the drop slot", async () => {
  await mountEditor(two([tab("a.ts"), tab("b.ts")], [tab("c.ts")]));
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /a\.ts/ }), { dataTransfer: data });
  const target = within(strip(2)).getByRole("tab", { name: /c\.ts/ });
  target.getBoundingClientRect = () => new DOMRect(0, 0, 100, 28);
  fireEvent.dragOver(target, { dataTransfer: data, clientX: 10, clientY: 10 });
  fireEvent.drop(strip(2), { dataTransfer: data });

  expect(tabNames(1)).toEqual(["b.ts"]);
  expect(tabNames(2)).toEqual(["a.ts", "c.ts"]);
});

test("the unsaved dot sits in the close slot and turns into × under the pointer", async () => {
  const editor = await mountEditor(one());
  const tabB = within(strip(1)).getByRole("tab", { name: /b\.ts/ });
  expect(within(tabB).getByRole("button", { name: "Close b.ts" }).dataset.shows).toBe("none");

  // Shown once (a hidden tab reads its file when first shown), then hidden again.
  fireEvent.click(tabB);
  await act(settle);
  fireEvent.click(within(strip(1)).getByRole("tab", { name: /a\.ts/ }));
  editor.edit("src/b.ts", "typed");
  const slot = within(tabB).getByRole("button", { name: "Close b.ts, unsaved" });
  expect(slot.dataset.shows).toBe("unsaved");
  fireEvent.mouseEnter(tabB);
  expect(slot.dataset.shows).toBe("close");
  fireEvent.mouseLeave(tabB);
  expect(slot.dataset.shows).toBe("unsaved");
});

test("middle-click closes a tab; double-click keeps a preview tab", async () => {
  await mountEditor(one([tab("a.ts"), tab("b.ts", { preview: true })]));
  const preview = within(strip(1)).getByRole("tab", { name: /b\.ts/ });
  expect(preview.dataset.preview).toBe("");
  fireEvent.doubleClick(preview);
  expect(preview.dataset.preview).toBeUndefined();

  fireEvent(
    within(strip(1)).getByRole("tab", { name: /a\.ts/ }),
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(tabNames(1)).toEqual(["b.ts"]);
});

test("two tabs with one name show their nearest differing folder", async () => {
  await mountEditor(one([tab("a/panels/index.ts"), tab("a/shell/index.ts")]));
  expect(tabNames(1)).toEqual(["index.ts· panels", "index.ts· shell"]);
});

test("closing an unsaved file's last tab keeps it open and asks the host", async () => {
  const onConfirmClose = vi.fn();
  const editor = await mountEditor(one(), { overrides: { onConfirmClose } });
  editor.edit("src/a.ts", "typed");
  fireEvent.click(within(strip(1)).getByRole("button", { name: "Close a.ts, unsaved" }));
  expect(tabNames(1)).toEqual(["a.ts", "b.ts"]);
  expect(onConfirmClose).toHaveBeenCalledWith([{ group: "g0", path: "src/a.ts" }]);
});

test("double-clicking a split's edge evens its sizes", async () => {
  const start = two();
  if (start.root.kind === "split") start.root.sizes = [0.75, 0.25];
  const editor = await mountEditor(start);
  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize groups" }));
  expect(editor.seen.at(-1)?.root).toMatchObject({ sizes: [0.5, 0.5] });
});

test("⌘2 inside the editor focuses group 2; ⌘ with no such group is left to the app", async () => {
  const outside = vi.fn();
  const listen = (event: KeyboardEvent) => outside(event.code);
  document.addEventListener("keydown", listen);
  const editor = await mountEditor(two());
  const tabA = within(strip(1)).getByRole("tab", { name: /a\.ts/ });
  fireEvent.keyDown(tabA, { code: "Digit2", key: "2", metaKey: true });
  expect(editor.seen.at(-1)?.focused).toBe("g9");
  expect(region(2).contains(document.activeElement)).toBe(true);
  expect(outside).not.toHaveBeenCalled();

  fireEvent.keyDown(within(strip(2)).getByRole("tab", { name: /c\.ts/ }), {
    code: "Digit5",
    key: "5",
    metaKey: true,
  });
  expect(outside).toHaveBeenCalledWith("Digit5");
  document.removeEventListener("keydown", listen);
});

test("closing the last tab of the last group shows the calm empty state", async () => {
  await mountEditor(one([tab("a.ts")]));
  fireEvent.click(within(strip(1)).getByRole("button", { name: "Close a.ts" }));
  expect(screen.getByText("No file open")).toBeTruthy();
});

test("closing a non-last group's last tab removes the group and focuses its neighbour", async () => {
  const editor = await mountEditor(two(undefined, undefined, "g9"));
  fireEvent.click(within(strip(2)).getByRole("button", { name: "Close c.ts" }));
  expect(screen.queryByRole("region", { name: "Group 2" })).toBeNull();
  const last = editor.seen.at(-1);
  expect(last && groupsOf(last).map((each) => each.id)).toEqual(["g0"]);
  expect(last?.focused).toBe("g0");
});

const caret = (line: number): EditorStatus => ({
  line,
  column: 1,
  selections: 1,
  selectedCharacters: 0,
  selectedLines: 0,
  indent: { tabs: false, size: 2 },
  lineEnding: "\n",
  encoding: "UTF-8",
  language: undefined,
  languageChosen: false,
  whitespace: false,
  readOnly: false,
});

test("a caret move redraws the status line without redrawing any tab strip", async () => {
  let report: ((status: EditorStatus) => void) | undefined;
  let tabRenders = 0;
  await mountEditor(two([tab("a.ts"), tab("b.ts")], [tab("c.ts")]), {
    overrides: {
      renderEditor: (props) => {
        if (props.group === "g0") report = (status) => props.onStatus(status);
        return null;
      },
      tabMenuItems: () => {
        tabRenders += 1;
        return null;
      },
    },
  });
  act(() => report?.(caret(3)));
  tabRenders = 0;
  act(() => report?.(caret(7)));

  expect(screen.getByText(/Ln 7, Col 1/)).toBeTruthy();
  expect(tabRenders).toBe(0);
});
