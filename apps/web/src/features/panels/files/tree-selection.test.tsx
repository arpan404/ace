import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, menuPick, openExplorer, row } from "./explorer-test-support.ts";

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
  const opened = await openExplorer();
  await expand(opened.tree, ["apps/", "apps/server/", src]);
  await userEvent.click(await row(opened.tree, `${src}cursor.ts`));
  await within(opened.panel).findByRole("tab", { name: "cursor.ts", selected: true });
  // The preview's tab mounts its own tree.
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  await waitFor(() => expect(selected(tree)).toEqual([`${src}cursor.ts`]));
  return { ...opened, tree };
}

test("the tree says it holds several selected rows", async () => {
  const { tree } = await openExplorer();
  expect(tree.getAttribute("aria-multiselectable")).toBe("true");
});

test("Ctrl+click toggles rows into the selection without opening them", async () => {
  const { panel, tree } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  expect(selected(tree)).toEqual([`${src}cursor.ts`, `${src}replay.ts`]);
  expect(within(panel).queryByRole("tab", { name: "replay.ts" })).toBeNull();
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
  const { panel, tree } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  await userEvent.click(await row(tree, `${src}replay.spec.ts`));
  await within(panel).findByRole("tab", { name: "replay.spec.ts", selected: true });
  const next = within(panel).getByRole("tree", { name: "Checkout files" });
  await waitFor(() => expect(selected(next)).toEqual([`${src}replay.spec.ts`]));
});

test("the menu of a selected row copies every selected path and deletes them together", async () => {
  const { tree } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  // After the clicks: a user-event setup brings its own clipboard.
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
  });
  await menuPick(await row(tree, `${src}replay.ts`), "Copy relative paths");
  await waitFor(() => expect(written.at(-1)).toBe(`${src}cursor.ts\n${src}replay.ts`));
  await menuPick(await row(tree, `${src}replay.ts`), /^Delete/);
  const dialog = await screen.findByRole("dialog", { name: "Delete" });
  expect(dialog.textContent).toContain("Move 2 items to Recently deleted?");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(tree.querySelector(`[data-path="${src}replay.ts"]`)).toBeNull());
  expect(tree.querySelector(`[data-path="${src}cursor.ts"]`)).toBeNull();
  // One Undo brings both back.
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await row(tree, `${src}cursor.ts`)).toBeTruthy();
  expect(await row(tree, `${src}replay.ts`)).toBeTruthy();
});

test("Mention in chat on a selection mentions each selected file", async () => {
  const { tree } = await serverFiles();
  await clickWith("Control", await row(tree, `${src}replay.ts`));
  await menuPick(await row(tree, `${src}cursor.ts`), "Mention in chat");
  const message = screen.getByRole("combobox", { name: "Message" });
  await waitFor(() => expect(message.textContent).toContain(`@${src}cursor.ts`));
  expect(message.textContent).toContain(`@${src}replay.ts`);
});
