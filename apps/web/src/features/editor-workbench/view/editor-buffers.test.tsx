import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { editorArea, one, region, strip, two } from "./editor-test-dom.ts";
import { mountEditor, root, tab } from "./editor-test-support.tsx";

/*
 * The editor over W2's registry: what each group shows for its buffer (the editor, a loading
 * skeleton, a line for a file it can't take), the notice when the disk moves under unsaved
 * edits, the one status line, Open editors, and the leases it holds.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const claude = { kind: "agent", agent: "Claude Code", threadId: "t1" } as const;

test("each group shows the shared buffer's text in a real editor", async () => {
  await mountEditor(two([tab("a.ts")], [tab("a.ts")]));
  // One buffer, two views: both groups draw the file's first line.
  await waitFor(() => {
    expect(editorArea(1).textContent).toContain("// a.ts");
    expect(editorArea(2).textContent).toContain("// a.ts");
  });
});

test("the notice appears when an agent writes a file with unsaved edits, and Merge lands it", async () => {
  const editor = await mountEditor(one(), { author: claude });
  await editor.changeOnDisk("src/a.ts", "// src/a.ts\nline two\nagent line\n");
  // A clean buffer just reloads: no notice.
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();

  editor.edit("src/a.ts", "mine");
  // The agent writes the top of the file; the person typed at its end: no overlap.
  await editor.changeOnDisk("src/a.ts", "agent again\n// src/a.ts\nline two\nagent line\n");
  expect(screen.getByText("Claude Code also changed this file.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(screen.queryByText(/also changed this file/)).toBeNull());
  const merged = editor.registry.get({ root, path: "src/a.ts" })?.document()?.text() ?? "";
  expect(merged).toContain("agent again");
  expect(merged).toContain("mine");
});

test("a change nobody can be named for says the file changed on disk", async () => {
  const editor = await mountEditor(one());
  editor.edit("src/a.ts", "mine");
  await editor.changeOnDisk("src/a.ts", "theirs\n");
  expect(screen.getByText("This file changed on disk.")).toBeTruthy();
});

const renderCompare = ({ path }: { path: string }) => (
  <div role="region" aria-label={`Compare ${path}`} />
);

test("Compare shows the host's diff in place of the editor until the change is answered", async () => {
  const editor = await mountEditor(one(), { author: claude, overrides: { renderCompare } });
  editor.edit("src/a.ts", "mine");
  await editor.changeOnDisk("src/a.ts", "theirs\n");
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(screen.getByRole("region", { name: "Compare src/a.ts" })).toBeTruthy();
  // Back and forth: the editor comes back without answering.
  fireEvent.click(screen.getByRole("button", { name: "Back to editor" }));
  expect(screen.queryByRole("region", { name: "Compare src/a.ts" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));

  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Compare src/a.ts" })).toBeNull(),
  );
  expect(screen.queryByText(/also changed this file/)).toBeNull();
  const buffer = editor.registry.get({ root, path: "src/a.ts" });
  expect(buffer?.document()?.text()).toContain("mine");
  expect(buffer?.snapshot().dirty).toBe(true);
});

test("one status line follows the focused group's editor", async () => {
  await mountEditor(two([tab("a.ts")], [tab("c.ts")]));
  await waitFor(() => expect(screen.getAllByLabelText("Editor status")).toHaveLength(1));
  const line = screen.getByLabelText("Editor status");
  await waitFor(() => expect(line.textContent).toContain("Ln 1, Col 1"));

  fireEvent.click(within(strip(2)).getByRole("tab", { name: /c\.ts/ }));
  expect(region(2).dataset.focused).toBe("");
  expect(screen.getAllByLabelText("Editor status")).toHaveLength(1);
});

test("files the editor can't take say what in one line", async () => {
  await mountEditor(one([tab("store.db"), tab("bundle.js")]), {
    odd: { unreadable: { "store.db": "binary", "bundle.js": "large" } },
  });
  expect(screen.getByText("store.db is a binary file.")).toBeTruthy();
  fireEvent.click(within(strip(1)).getByRole("tab", { name: /bundle\.js/ }));
  // A hidden tab reads its file only once shown.
  expect(await screen.findByText("bundle.js is too large to edit here.")).toBeTruthy();
});

test("a deleted file says so and offers Close", async () => {
  const editor = await mountEditor(one([tab("a.ts"), tab("b.ts")]));
  editor.disk.remove("a.ts");
  await act(() => editor.registry.get({ root, path: "a.ts" })?.reload());
  expect(screen.getByText("This file was deleted.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(
    within(strip(1))
      .getAllByRole("tab")
      .map((each) => each.textContent),
  ).toEqual(["b.ts"]);
});

test("a loading file shows skeleton lines only after 150 ms, never at once", async () => {
  await mountEditor(one([tab("slow.ts")]), { odd: { pending: ["slow.ts"] } });
  expect(screen.getByLabelText("Loading file").children).toHaveLength(0);
  await waitFor(() =>
    expect(screen.getByLabelText("Loading file").children.length).toBeGreaterThan(0),
  );
});

test("Open editors groups rows and offers Save all only while something is unsaved", async () => {
  const onSaveAll = vi.fn();
  const editor = await mountEditor(two([tab("src/a.ts")], [tab("docs/c.md")]), { onSaveAll });
  const list = screen.getByRole("region", { name: "Open editors" });
  expect(within(list).getByText("Group 1")).toBeTruthy();
  expect(within(list).getByText("Group 2")).toBeTruthy();
  expect(within(list).queryByRole("button", { name: "Save all" })).toBeNull();

  editor.edit("docs/c.md", "typed");
  fireEvent.click(within(list).getByRole("button", { name: "Save all" }));
  expect(onSaveAll).toHaveBeenCalledWith(["docs/c.md"]);
  expect(within(list).getByRole("button", { name: "Close c.md, unsaved" }).dataset.shows).toBe(
    "unsaved",
  );
});

test("the editor holds a buffer while a tab has its file, and lets a clean one go on close", async () => {
  const editor = await mountEditor(one([tab("a.ts"), tab("b.ts")]));
  expect(editor.registry.get({ root, path: "b.ts" })).toBeDefined();
  fireEvent.click(within(strip(1)).getByRole("button", { name: "Close b.ts" }));
  await waitFor(() => expect(editor.registry.get({ root, path: "b.ts" })).toBeUndefined());
  expect(editor.registry.get({ root, path: "a.ts" })).toBeDefined();
});

test("unsaved lines keep their gutter mark when the editor shows the file again", async () => {
  const editor = await mountEditor(one([tab("a.ts"), tab("b.ts")]));
  editor.edit("a.ts", "mine");
  // Away to b.ts and back: a fresh view on a.ts's buffer, which still differs from the disk.
  fireEvent.click(within(strip(1)).getByRole("tab", { name: /b\.ts/ }));
  fireEvent.click(within(strip(1)).getByRole("tab", { name: /a\.ts/ }));
  await waitFor(() =>
    expect(
      editorArea(1).querySelector('[data-line="2"] [data-mark]')?.getAttribute("data-mark"),
    ).toBe("added"),
  );
});
