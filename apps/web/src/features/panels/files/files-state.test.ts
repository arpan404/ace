import { expect, test } from "vitest";
import { FilesMemory, treeLayout } from "./files-state.ts";

test("beside a file the tree shows only while the source keeps 420px, else it steps aside", () => {
  expect(treeLayout(900, 240, { file: true, chosen: undefined })).toBe("beside");
  expect(treeLayout(520, 240, { file: true, chosen: undefined })).toBe("hidden");
});

test("asked for in a narrow tab, the tree opens over the file", () => {
  expect(treeLayout(520, 240, { file: true, chosen: true })).toBe("over");
});

test("an empty tab shows the tree beside its empty state at any width, unless hidden by hand", () => {
  expect(treeLayout(520, 240, { file: false, chosen: undefined })).toBe("beside");
  expect(treeLayout(520, 240, { file: false, chosen: false })).toBe("hidden");
  expect(treeLayout(1200, 240, { file: true, chosen: false })).toBe("hidden");
});

function storage(stored?: Record<string, unknown>) {
  const values = new Map<string, string>();
  if (stored) values.set("ace.files.prefs", JSON.stringify(stored));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    read: (key: string) => values.get(key),
  };
}

test("wrap starts off, as it always has, and is kept with the Files tool's own preferences", () => {
  const store = storage();
  const memory = new FilesMemory(store);
  expect(memory.prefs.wrap).toBe(false);

  memory.setPrefs({ wrap: true });

  expect(memory.prefs).toEqual({ treeWidth: 240, wrap: true });
  expect(JSON.parse(store.read("ace.files.prefs") ?? "{}")).toEqual({
    treeWidth: 240,
    wrap: true,
  });
});

test("a stored wrap preference comes back with the tab's other settings", () => {
  const memory = new FilesMemory(storage({ treeWidth: 300, wrap: true }));
  expect(memory.prefs).toEqual({ treeWidth: 300, wrap: true });
});
