import { groupsOf } from "@ace/ui-core/editor-workbench";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
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
import { mountEditor, tab } from "./editor-test-support.tsx";

/*
 * Groups as the person sees them: a split shows side by side while each group has room, asks
 * for room when it doesn't, and only then shows one group with the others a click away. Files
 * dragged from the explorer open where they drop; the strip splits with one button.
 */

beforeAll(allowDragEvents);

const realBox = HTMLElement.prototype.getBoundingClientRect;
/** The editor measures itself at this size. */
function editorSize(width: number, height = 700) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.part === "editor") return new DOMRect(0, 0, width, height);
    return realBox.call(this);
  };
}
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realBox;
});

test("a split shows both groups side by side once each has 320px, under the compact width", async () => {
  editorSize(700);
  await mountEditor(two());
  expect(region(1)).toBeTruthy();
  expect(region(2)).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Groups" })).toBeNull();
});

test("a split without room asks for it, and shows one group with the others a click away", async () => {
  editorSize(600);
  const onNeedRoom = vi.fn();
  await mountEditor(two(), { overrides: { onNeedRoom } });
  expect(onNeedRoom).toHaveBeenCalledWith(640);
  expect(screen.queryByRole("region", { name: "Group 2" })).toBeNull();
  expect(tabNames(1)).toEqual(["a.ts"]);

  const groups = screen.getByRole("group", { name: "Groups" });
  fireEvent.click(within(groups).getByRole("button", { name: "Group 2" }));
  expect(screen.queryByRole("region", { name: "Group 1" })).toBeNull();
  expect(tabNames(2)).toEqual(["c.ts"]);
});

test("a file dragged from this thread's explorer opens kept in the group it drops on", async () => {
  editorSize(1000);
  const editor = await mountEditor(two(), { overrides: { threadId: "t1" } });
  const area = editorArea(2);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  data.setData(
    "application/x-ace-tree-entries",
    JSON.stringify({ threadId: "t1", entries: [{ path: "src/new.ts", folder: false }] }),
  );
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 150, clientY: 150 });
  expect(area.querySelector("[data-drop-zone]")?.getAttribute("data-drop-zone")).toBe("center");
  fireEvent.drop(area, { dataTransfer: data, clientX: 150, clientY: 150 });

  expect(tabNames(2)).toEqual(["c.ts", "new.ts"]);
  const placed = groupsOf(editor.seen.at(-1)!)[1]?.tabs.find((each) => each.path === "src/new.ts");
  expect(placed?.preview).toBe(false);
});

test("a file dragged onto a group's outer third opens in a new group on that side", async () => {
  editorSize(1000);
  await mountEditor(one([tab("a.ts")]), { overrides: { threadId: "t1" } });
  const area = editorArea(1);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  data.setData(
    "application/x-ace-tree-entries",
    JSON.stringify({ threadId: "t1", entries: [{ path: "b.ts", folder: false }] }),
  );
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  fireEvent.drop(area, { dataTransfer: data, clientX: 290, clientY: 150 });

  expect(tabNames(1)).toEqual(["a.ts"]);
  expect(tabNames(2)).toEqual(["b.ts"]);
});

test("a file dragged from another thread's explorer opens nothing", async () => {
  editorSize(1000);
  await mountEditor(one([tab("a.ts")]), { overrides: { threadId: "t1" } });
  const area = editorArea(1);
  const data = transfer();
  data.setData(
    "application/x-ace-tree-entries",
    JSON.stringify({ threadId: "t2", entries: [{ path: "b.ts", folder: false }] }),
  );
  fireEvent.dragOver(area, { dataTransfer: data });
  fireEvent.drop(area, { dataTransfer: data });
  expect(tabNames(1)).toEqual(["a.ts"]);
});

test("a tab dropped on the code is taken before the text input can paste its path", async () => {
  editorSize(1000);
  await mountEditor(two([tab("a.ts"), tab("b.ts")], [tab("c.ts")]));
  const area = editorArea(2);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const input = document.createElement("textarea");
  area.append(input);
  const pasted = vi.fn();
  input.addEventListener("drop", pasted);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(input, { dataTransfer: data, clientX: 150, clientY: 150 });
  fireEvent.drop(input, { dataTransfer: data, clientX: 150, clientY: 150 });

  expect(pasted).not.toHaveBeenCalled();
  expect(tabNames(2)).toEqual(["c.ts", "b.ts"]);
});

test("the strip's split button splits right, and with ⌥ splits down", async () => {
  editorSize(1000);
  const editor = await mountEditor(one([tab("a.ts")]));
  fireEvent.click(within(region(1)).getByRole("button", { name: "Split right" }));
  expect(editor.seen.at(-1)?.root).toMatchObject({ kind: "split", direction: "row" });
  expect(tabNames(2)).toEqual(["a.ts"]);

  fireEvent.click(within(region(2)).getByRole("button", { name: "Split right" }), { altKey: true });
  expect(groupsOf(editor.seen.at(-1)!)).toHaveLength(3);
  expect(JSON.stringify(editor.seen.at(-1)?.root)).toContain('"direction":"column"');
});
