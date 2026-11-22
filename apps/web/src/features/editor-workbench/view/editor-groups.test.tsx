import { groupsOf } from "@ace/ui-core/editor-workbench";
import { treeEntriesDragType } from "@/lib/workspace/index.ts";
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

/** How the panes sit: an edge between side-by-side panes stands vertical. */
const edges = () =>
  screen
    .queryAllByRole("separator", { name: "Resize panes" })
    .map((edge) => edge.getAttribute("aria-orientation"));

test("two panes sit side by side once each has 420px", async () => {
  editorSize(900);
  await mountEditor(two());
  expect(tabNames(1)).toEqual(["a.ts"]);
  expect(tabNames(2)).toEqual(["c.ts"]);
  expect(edges()).toEqual(["vertical"]);
});

test("two panes in 640px ask for room and still sit side by side, narrower", async () => {
  editorSize(640);
  const onNeedRoom = vi.fn();
  await mountEditor(two(), { overrides: { onNeedRoom } });
  expect(onNeedRoom).toHaveBeenCalledWith(840);
  expect(edges()).toEqual(["vertical"]);
  expect(tabNames(2)).toEqual(["c.ts"]);
});

test("panes without room for 280px each stack, both still on screen, and the word Group never shows", async () => {
  editorSize(500);
  await mountEditor(two());
  expect(edges()).toEqual(["horizontal"]);
  expect(tabNames(1)).toEqual(["a.ts"]);
  expect(tabNames(2)).toEqual(["c.ts"]);
  expect(screen.queryByText(/Group/)).toBeNull();
});

test("a right split with no room beside goes below, so it shows", async () => {
  editorSize(500);
  const editor = await mountEditor(one([tab("a.ts")]));
  fireEvent.click(within(region(1)).getByRole("button", { name: "Split right" }));
  expect(editor.seen.at(-1)?.root).toMatchObject({ kind: "split", direction: "column" });
  expect(tabNames(2)).toEqual(["a.ts"]);
});

test("a right-edge drop with no room beside washes and lands below", async () => {
  editorSize(500);
  const editor = await mountEditor(one([tab("a.ts"), tab("b.ts")]));
  const area = editorArea(1);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  expect(area.querySelector("[data-drop-zone]")?.getAttribute("data-drop-zone")).toBe("down");
  fireEvent.drop(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  expect(editor.seen.at(-1)?.root).toMatchObject({ kind: "split", direction: "column" });
});

test("at the pane cap, edges take no drop and Split right is off", async () => {
  editorSize(1000);
  const editor = await mountEditor(two([tab("a.ts"), tab("b.ts")]), { overrides: { paneCap: 2 } });
  const area = editorArea(1);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  expect(area.querySelector("[data-drop-zone]")).toBeNull();
  fireEvent.drop(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  expect(screen.queryByRole("region", { name: "Pane 3" })).toBeNull();
  expect(editor.seen.every((layout) => groupsOf(layout).length <= 2)).toBe(true);
  // Visibly off (focusable, so its tooltip can say why), and a press makes no third pane.
  const split = within(region(1)).getByRole("button", { name: "Split right" });
  expect(split.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(split);
  expect(screen.queryByRole("region", { name: "Pane 3" })).toBeNull();
});

test("a tab dropped on the edge of a pane already showing its file only moves focus there", async () => {
  editorSize(1000);
  const editor = await mountEditor(two([tab("a.ts"), tab("b.ts")], [tab("b.ts")]));
  const area = editorArea(2);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  fireEvent.drop(area, { dataTransfer: data, clientX: 290, clientY: 150 });
  const last = editor.seen.at(-1);
  expect(last && groupsOf(last)).toHaveLength(2);
  expect(last?.focused).toBe("g9");
  expect(tabNames(1)).toEqual(["a.ts", "b.ts"]);
});

test("a file dragged from this thread's explorer opens kept in the group it drops on", async () => {
  editorSize(1000);
  const editor = await mountEditor(two(), { overrides: { threadId: "t1" } });
  const area = editorArea(2);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  data.setData(
    treeEntriesDragType,
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
    treeEntriesDragType,
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
    treeEntriesDragType,
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

test("the file path starts where the shown editor's text starts", async () => {
  editorSize(1000);
  await mountEditor(one([tab("src/a.ts")]), {
    overrides: { renderEditor: () => <div data-text-start="68" /> },
  });
  const crumbs = within(region(1)).getByRole("navigation", { name: "File path" });
  expect(crumbs.style.paddingLeft).toBe("68px");
});

test("split right puts the keyboard in the new group's view", async () => {
  editorSize(1000);
  await mountEditor(one([tab("a.ts")]), {
    overrides: {
      renderEditor: (view) => <textarea aria-label={`Source in ${view.group}`} />,
    },
  });
  const first = within(region(1)).getByRole("textbox");
  first.focus();
  fireEvent.click(within(region(1)).getByRole("button", { name: "Split right" }));

  const second = within(region(2)).getByRole("textbox");
  expect(document.activeElement).toBe(second);
});

test("a stored uneven split keeps its proportions, each group held to its 420px", async () => {
  editorSize(1044);
  const start = two();
  const uneven = { ...start, root: { ...start.root, sizes: [0.75, 0.25] } };
  await mountEditor(uneven as typeof start);
  const slots = [region(1), region(2)].map((each) => each.parentElement);
  expect(slots.map((slot) => slot?.style.flexGrow)).toEqual(["0.75", "0.25"]);
  expect(slots.map((slot) => slot?.style.minWidth)).toEqual(["420px", "420px"]);
});

/** Four panes stacked, the second focused: the shape a narrow panel shows. */
const fourStacked = () => ({
  root: {
    kind: "split" as const,
    direction: "column" as const,
    sizes: [0.25, 0.25, 0.25, 0.25],
    children: ["g1", "g2", "g3", "g4"].map((id) => ({
      kind: "group" as const,
      id,
      tabs: [tab(`${id}.ts`)],
      active: `${id}.ts`,
      mru: [`${id}.ts`],
    })),
  },
  focused: "g2",
});
/** A pane shows its file (breadcrumbs and code) or only its strip. */
const open = () =>
  [1, 2, 3, 4].map(
    (n) => within(region(n)).queryByRole("navigation", { name: "File path" }) !== null,
  );

test("stacked panes without room open the focused one and fold the rest to their strips", async () => {
  editorSize(500, 600);
  await mountEditor(fourStacked());
  expect(open()).toEqual([false, true, false, false]);
  // The open pane takes all the room the strips leave: its share is the whole, theirs none.
  const slots = [1, 2, 3, 4].map((n) => region(n).parentElement?.style.flexGrow);
  expect(slots).toEqual(["0", "1", "0", "0"]);
  // Every pane is still on screen, at least as its strip.
  expect([1, 2, 3, 4].map((n) => tabNames(n)[0])).toEqual(["g1.ts", "g2.ts", "g3.ts", "g4.ts"]);
});

test("a click on a folded pane's strip opens it and folds the one before", async () => {
  editorSize(500, 600);
  await mountEditor(fourStacked());
  fireEvent.pointerDown(within(strip(3)).getByRole("tab", { name: /g3\.ts/ }));
  fireEvent.click(within(strip(3)).getByRole("tab", { name: /g3\.ts/ }));
  expect(open()).toEqual([false, false, true, false]);
});

test("⌘4 inside the editor opens the fourth stacked pane", async () => {
  editorSize(500, 600);
  await mountEditor(fourStacked());
  fireEvent.keyDown(within(strip(2)).getByRole("tab", { name: /g2\.ts/ }), {
    code: "Digit4",
    key: "4",
    metaKey: true,
  });
  expect(open()).toEqual([false, false, false, true]);
});

test("stacked panes the person resizes keep their sizes, every pane open", async () => {
  editorSize(500, 600);
  await mountEditor(fourStacked());
  const [first] = screen.getAllByRole("separator", { name: "Resize panes" });
  if (!first) throw new Error("no edge");
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(open()).toEqual([true, true, true, true]);
});
