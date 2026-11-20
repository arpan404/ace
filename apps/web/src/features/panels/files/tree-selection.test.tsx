import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { threadId } from "./tree-test-queries.ts";
import { bytes, expand, menuPick, renderTree, row } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

const src = "apps/server/src/";
const selected = (tree: HTMLElement) =>
  [...tree.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map((each) =>
    each.getAttribute("data-path"),
  );

/** Click with a modifier held, as a person holding Ctrl or Shift does. */
async function clickWith(key: "Control" | "Shift", target: HTMLElement) {
  const user = userEvent.setup();
  await user.keyboard(`{${key}>}`);
  await user.click(target);
  await user.keyboard(`{/${key}}`);
}

/** Show apps/server/src and preview cursor.ts, which leaves it the one selected row. */
async function serverFiles() {
  const opened = await renderTree();
  await expand(opened.tree, ["apps/", "apps/server/", src]);
  await userEvent.click(await row(opened.tree, `${src}cursor.ts`));
  // The Files tab mounts a fresh tree for the file it opens.
  const tree = await opened.remount();
  await waitFor(() => expect(selected(tree)).toEqual([`${src}cursor.ts`]));
  return { ...opened, tree };
}

/** Copies to the clipboard, from now on (a user-event setup brings its own clipboard). */
function clipboardWrites() {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
  });
  return written;
}

test("the tree says it holds several selected rows", async () => {
  const { tree } = await renderTree();
  expect(tree.getAttribute("aria-multiselectable")).toBe("true");
});

test("Ctrl+click toggles rows into the selection without opening them", async () => {
  const { tree, outputs } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  expect(selected(tree)).toEqual([`${src}cursor.ts`, `${src}replay.ts`]);
  expect(outputs.opened.map((each) => each.path)).not.toContain(`${src}replay.ts`);
  await clickWith("Control", await row(tree, `${src}cursor.ts`));
  expect(selected(tree)).toEqual([`${src}replay.ts`]);
  // A folder toggles into the selection too, without opening.
  await clickWith("Control", await row(tree, "apps/"));
  expect((await row(tree, "apps/")).getAttribute("aria-expanded")).toBe("true");
  expect(selected(tree)).toContain("apps/");
});

test("Shift+click selects the range from the last picked row", async () => {
  const { tree } = await serverFiles();
  await clickWith("Shift", await row(tree, `${src}replay.ts`));
  expect(selected(tree)).toEqual([`${src}cursor.ts`, `${src}replay.spec.ts`, `${src}replay.ts`]);
});

test("Shift+Down extends the selection from the keyboard and Ctrl+A selects every row", async () => {
  const { tree } = await serverFiles();
  (await row(tree, `${src}cursor.ts`)).focus();
  await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
  expect(selected(tree)).toEqual([`${src}cursor.ts`, `${src}replay.spec.ts`, `${src}replay.ts`]);
  expect(document.activeElement).toBe(await row(tree, `${src}replay.ts`));
  await userEvent.keyboard("{Control>}a{/Control}");
  expect(selected(tree).length).toBe(tree.querySelectorAll('[role="treeitem"][data-path]').length);
});

test("a plain click picks one row again", async () => {
  const { tree, outputs, remount } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  await userEvent.click(await row(tree, `${src}replay.spec.ts`));
  expect(outputs.opened.at(-1)).toEqual({ path: `${src}replay.spec.ts`, how: "preview" });
  const next = await remount();
  await waitFor(() => expect(selected(next)).toEqual([`${src}replay.spec.ts`]));
});

test("the menu of a selected row copies every selected path and deletes them together", async () => {
  const { tree, outputs } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  const written = clipboardWrites();
  await menuPick(await row(tree, `${src}replay.ts`), "Copy relative paths");
  await waitFor(() => expect(written.at(-1)).toBe(`${src}cursor.ts\n${src}replay.ts`));
  await menuPick(await row(tree, `${src}replay.ts`), /^Delete/);
  const dialog = await screen.findByRole("dialog", { name: "Delete" });
  expect(dialog.textContent).toContain("Move 2 items to Recently deleted?");
  expect(outputs.operations).toEqual([
    expect.objectContaining({ kind: "delete", paths: [`${src}cursor.ts`, `${src}replay.ts`] }),
  ]);
});

test("Mention in chat on a selection mentions each selected file", async () => {
  const { tree, outputs } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  await menuPick(await row(tree, `${src}cursor.ts`), "Mention in chat");
  expect(outputs.mentions).toEqual([[{ path: `${src}cursor.ts` }, { path: `${src}replay.ts` }]]);
});

test("deleting a selection moves every row away, and one Undo brings them back", async () => {
  const { tree } = await renderTree();
  await clickWith("Control", await row(tree, "README.md"));
  await clickWith("Control", await row(tree, "package.json"));
  await menuPick(await row(tree, "package.json"), /^Delete/);
  const dialog = await screen.findByRole("dialog", { name: "Delete" });
  expect(dialog.textContent).toContain("Move 2 items to Recently deleted?");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(tree.querySelector('[data-path="README.md"]')).toBeNull());
  expect(tree.querySelector('[data-path="package.json"]')).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await row(tree, "README.md")).toBeTruthy();
  expect(await row(tree, "package.json")).toBeTruthy();
});

test("Undo of a bulk delete restores every path that is free and names the ones taken since", async () => {
  const { client, tree } = await renderTree();
  await clickWith("Control", await row(tree, "README.md"));
  await clickWith("Control", await row(tree, "package.json"));
  await menuPick(await row(tree, "package.json"), /^Delete/);
  const dialog = await screen.findByRole("dialog", { name: "Delete" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(tree.querySelector('[data-path="README.md"]')).toBeNull());
  // An agent writes a new package.json before Undo.
  await client.request({
    type: "files.request",
    threadId,
    operation: { op: "create", path: "package.json", expected: null, text: "new" },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await row(tree, "README.md")).toBeTruthy();
  expect(await screen.findAllByText(/package\.json is taken/)).not.toHaveLength(0);
  expect(await bytes({ client }, "package.json")).toBe("new");
});
