import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import type { EditorStatus } from "./deck-host.ts";
import { group, StatefulDeck, tab } from "./deck-test-support.tsx";
import { groupsOf, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { memoryBuffers } from "./memory-buffers.ts";

/*
 * The Deck through its rendered view: tabs, strips, drops, the notice and the status line,
 * with the layout held by W1's model and buffer facts set by hand.
 */

beforeAll(() => {
  // jsdom has no DragEvent; a MouseEvent carries the pointer position the drop needs.
  if (!("DragEvent" in window)) Object.assign(window, { DragEvent: MouseEvent });
});

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

function strip(number: number): HTMLElement {
  return within(screen.getByRole("region", { name: `Group ${number}` })).getByRole("tablist");
}

function editorArea(number: number): HTMLElement {
  const area = screen
    .getByRole("region", { name: `Group ${number}` })
    .querySelector<HTMLElement>('[data-part="deck-editor"]');
  if (!area) throw new Error("no editor area");
  return area;
}

type Start = Pick<EditorLayout, "root" | "focused">;

const one = (tabs = [tab("src/a.ts"), tab("src/b.ts")]): Start => ({
  root: group("g0", tabs),
  focused: "g0",
});

test("dragging a tab to a group's right third makes a new group holding it", () => {
  const seen: EditorLayout[] = [];
  render(<StatefulDeck initial={one()} buffers={memoryBuffers()} onLayout={(l) => seen.push(l)} />);
  const area = editorArea(1);
  area.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /b\.ts/ }), { dataTransfer: data });
  fireEvent.dragOver(area, { dataTransfer: data, clientX: 280, clientY: 150 });
  fireEvent.drop(area, { dataTransfer: data, clientX: 280, clientY: 150 });

  expect(
    within(strip(1))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["a.ts"]);
  expect(
    within(strip(2))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["b.ts"]);
  expect(seen.at(-1)?.root).toMatchObject({ kind: "split", direction: "row" });
});

test("dropping a tab on another group's strip moves it there at the drop slot", () => {
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("a.ts"), tab("b.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g0",
  };
  render(<StatefulDeck initial={initial} buffers={memoryBuffers()} />);
  const data = transfer();
  fireEvent.dragStart(within(strip(1)).getByRole("tab", { name: /a\.ts/ }), { dataTransfer: data });
  const target = within(strip(2)).getByRole("tab", { name: /c\.ts/ });
  target.getBoundingClientRect = () => new DOMRect(0, 0, 100, 28);
  fireEvent.dragOver(target, { dataTransfer: data, clientX: 10, clientY: 10 });
  fireEvent.drop(strip(2), { dataTransfer: data });

  expect(
    within(strip(1))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["b.ts"]);
  expect(
    within(strip(2))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["a.ts", "c.ts"]);
});

test("the unsaved dot sits in the close slot and turns into × under the pointer", () => {
  const buffers = memoryBuffers({ "src/b.ts": { unsaved: true } });
  render(<StatefulDeck initial={one()} buffers={buffers} />);
  const tabB = within(strip(1)).getByRole("tab", { name: /b\.ts/ });
  const slot = within(tabB).getByRole("button", { name: "Close b.ts, unsaved" });
  expect(slot.dataset.shows).toBe("unsaved");

  fireEvent.mouseEnter(tabB);
  expect(slot.dataset.shows).toBe("close");
  fireEvent.mouseLeave(tabB);
  expect(slot.dataset.shows).toBe("unsaved");

  act(() => buffers.set("src/b.ts", { unsaved: false }));
  expect(within(tabB).getByRole("button", { name: "Close b.ts" }).dataset.shows).toBe("none");
});

test("middle-click closes a tab; double-click keeps a preview tab", () => {
  render(
    <StatefulDeck
      initial={one([tab("a.ts"), tab("b.ts", { preview: true })])}
      buffers={memoryBuffers()}
    />,
  );
  const preview = within(strip(1)).getByRole("tab", { name: /b\.ts/ });
  expect(preview.dataset.preview).toBe("");
  fireEvent.doubleClick(preview);
  expect(preview.dataset.preview).toBeUndefined();

  fireEvent(
    within(strip(1)).getByRole("tab", { name: /a\.ts/ }),
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(
    within(strip(1))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["b.ts"]);
});

test("two tabs with one name show their nearest differing folder", () => {
  render(
    <StatefulDeck
      initial={one([tab("a/panels/index.ts"), tab("a/shell/index.ts")])}
      buffers={memoryBuffers()}
    />,
  );
  expect(
    within(strip(1))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["index.ts· panels", "index.ts· shell"]);
});

test("the agent notice appears when the disk moves under unsaved edits and leaves once cleared", () => {
  const buffers = memoryBuffers({ "src/a.ts": { unsaved: true } });
  const onMerge = vi.fn();
  const onCompare = vi.fn();
  render(<StatefulDeck initial={one()} buffers={buffers} overrides={{ onMerge, onCompare }} />);
  expect(screen.queryByText(/also changed this file/)).toBeNull();

  act(() =>
    buffers.set("src/a.ts", {
      clash: { merging: false },
      changedBy: { name: "Claude Code", provider: "claude" },
    }),
  );
  expect(screen.getByText("Claude Code also changed this file.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(onMerge).toHaveBeenCalledWith("src/a.ts");
  expect(onCompare).toHaveBeenCalledWith("src/a.ts");

  act(() => buffers.set("src/a.ts", { clash: { merging: true } }));
  expect(screen.getByRole("button", { name: "Merge" }).hasAttribute("disabled")).toBe(true);

  act(() => buffers.set("src/a.ts", { clash: undefined }));
  expect(screen.queryByText(/also changed this file/)).toBeNull();
});

test("a change nobody can be named for says the file changed on disk", () => {
  const buffers = memoryBuffers({ "src/a.ts": { unsaved: true, clash: { merging: false } } });
  render(<StatefulDeck initial={one()} buffers={buffers} />);
  expect(screen.getByText("This file changed on disk.")).toBeTruthy();
});

test("the status line shows only the focused group's editor status", () => {
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("a.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g0",
  };
  render(
    <StatefulDeck
      initial={initial}
      buffers={memoryBuffers()}
      overrides={{
        renderEditor: (editor) => (
          <StatusReporter label={`at ${editor.path}`} report={editor.onStatus} />
        ),
      }}
    />,
  );
  const footer = screen.getByRole("contentinfo", { name: "Editor status" });
  expect(footer.textContent).toContain("at a.ts");
  expect(footer.textContent).not.toContain("at c.ts");

  fireEvent.click(within(strip(2)).getByRole("tab", { name: /c\.ts/ }));
  expect(footer.textContent).toContain("at c.ts");
  expect(footer.textContent).not.toContain("at a.ts");
});

/** Reports its status on mount and clears it on unmount, as the editor handle will. */
function StatusReporter(props: { label: string; report(status: EditorStatus | undefined): void }) {
  const { label, report } = props;
  useEffect(() => {
    report({ items: [{ id: "pos", label }] });
    return () => report(undefined);
  }, [label, report]);
  return <div />;
}

test("double-clicking a split's edge evens its sizes", () => {
  const seen: EditorLayout[] = [];
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [3, 1],
      children: [group("g0", [tab("a.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g0",
  };
  render(
    <StatefulDeck initial={initial} buffers={memoryBuffers()} onLayout={(l) => seen.push(l)} />,
  );
  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize groups" }));
  expect(seen.at(-1)?.root).toMatchObject({ sizes: [0.5, 0.5] });
});

test("⌘2 inside the Deck focuses group 2; ⌘ with no such group is left to the app", () => {
  const seen: EditorLayout[] = [];
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("a.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g0",
  };
  const outside = vi.fn();
  render(
    <div role="group" onKeyDown={(event) => outside(event.code)}>
      <StatefulDeck initial={initial} buffers={memoryBuffers()} onLayout={(l) => seen.push(l)} />
    </div>,
  );
  const editor = screen.getByLabelText("Editor a.ts");
  fireEvent.keyDown(editor, { code: "Digit2", key: "2", metaKey: true });
  expect(seen.at(-1)?.focused).toBe("g9");
  expect(document.activeElement).toBe(screen.getByLabelText("Editor c.ts"));
  expect(outside).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByLabelText("Editor c.ts"), {
    code: "Digit5",
    key: "5",
    metaKey: true,
  });
  expect(outside).toHaveBeenCalledWith("Digit5");
});

test("closing the last tab of the last group shows the calm empty state", () => {
  render(<StatefulDeck initial={one([tab("a.ts")])} buffers={memoryBuffers()} />);
  fireEvent.click(within(strip(1)).getByRole("button", { name: "Close a.ts" }));
  expect(screen.getByText("No file open")).toBeTruthy();
});

test("closing a non-last group's last tab removes the group", () => {
  const seen: EditorLayout[] = [];
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("a.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g9",
  };
  render(
    <StatefulDeck initial={initial} buffers={memoryBuffers()} onLayout={(l) => seen.push(l)} />,
  );
  fireEvent.click(within(strip(2)).getByRole("button", { name: "Close c.ts" }));
  expect(screen.queryByRole("region", { name: "Group 2" })).toBeNull();
  const last = seen.at(-1);
  expect(last && groupsOf(last).map((each) => each.id)).toEqual(["g0"]);
  expect(seen.at(-1)?.focused).toBe("g0");
});

test("a file that can't be shown says what in one line", () => {
  const buffers = memoryBuffers({
    "store.db": { load: { state: "binary" } },
    "big.js": { load: { state: "too-large", bytes: 48_000_000 } },
  });
  render(<StatefulDeck initial={one([tab("store.db"), tab("big.js")])} buffers={buffers} />);
  expect(screen.getByText("store.db is a binary file.")).toBeTruthy();
  fireEvent.click(within(strip(1)).getByRole("tab", { name: /big\.js/ }));
  expect(screen.getByText("big.js is 48 MB, too large to edit here.")).toBeTruthy();
});

test("a loading file shows skeleton lines only after 150 ms", () => {
  vi.useFakeTimers();
  try {
    render(
      <StatefulDeck
        initial={one([tab("a.ts")])}
        buffers={memoryBuffers({ "a.ts": { load: { state: "loading" } } })}
      />,
    );
    const busy = screen.getByLabelText("Loading file");
    expect(busy.children).toHaveLength(0);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByLabelText("Loading file").children.length).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
  }
});

test("Open editors groups rows by group and offers Save all only while something is unsaved", () => {
  const buffers = memoryBuffers();
  const onSaveAll = vi.fn();
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("src/a.ts")]), group("g9", [tab("docs/c.md")])],
    },
    focused: "g0",
  };
  render(<StatefulDeck initial={initial} buffers={buffers} onSaveAll={onSaveAll} />);
  const list = screen.getByRole("region", { name: "Open editors" });
  expect(within(list).getByText("Group 1")).toBeTruthy();
  expect(within(list).getByText("Group 2")).toBeTruthy();
  expect(within(list).queryByRole("button", { name: "Save all" })).toBeNull();

  act(() => buffers.set("docs/c.md", { unsaved: true }));
  fireEvent.click(within(list).getByRole("button", { name: "Save all" }));
  expect(onSaveAll).toHaveBeenCalledWith(["docs/c.md"]);
  expect(within(list).getByRole("button", { name: "Close c.md, unsaved" }).dataset.shows).toBe(
    "unsaved",
  );
});

test("picking a row in Open editors shows that file in its group", () => {
  const initial: Start = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [1, 1],
      children: [group("g0", [tab("a.ts"), tab("b.ts")]), group("g9", [tab("c.ts")])],
    },
    focused: "g9",
  };
  render(<StatefulDeck initial={initial} buffers={memoryBuffers()} />);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Open editors" })).getByRole("button", {
      name: "b.ts",
    }),
  );
  expect(screen.getByLabelText("Editor b.ts").dataset.group).toBe("g0");
  expect(screen.getByRole("region", { name: "Group 1" }).dataset.focused).toBe("");
});
