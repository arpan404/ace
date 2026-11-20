import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { bytes, menuPick, openExplorer, row } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

async function press(target: HTMLElement, keys: string) {
  target.focus();
  await userEvent.keyboard(keys);
}

test("Ctrl+C then Ctrl+V on a folder copies the file into it and keeps the original", async () => {
  const { app, tree } = await openExplorer();
  const before = await bytes(app, "README.md");
  await press(await row(tree, "README.md"), "{Control>}c{/Control}");
  await press(await row(tree, "apps/"), "{Control>}v{/Control}");
  await userEvent.click(await row(tree, "apps/"));
  expect(await row(tree, "apps/README.md")).toBeTruthy();
  expect(await bytes(app, "apps/README.md")).toBe(before);
  expect(await row(tree, "README.md")).toBeTruthy();
});

test("pasting where the name is taken picks 'name copy'", async () => {
  const { app, tree } = await openExplorer();
  const before = await bytes(app, "README.md");
  await press(await row(tree, "README.md"), "{Control>}c{/Control}");
  // On a file, paste goes into the file's own folder.
  await press(await row(tree, "README.md"), "{Control>}v{/Control}");
  expect(await row(tree, "README copy.md")).toBeTruthy();
  expect(await bytes(app, "README copy.md")).toBe(before);
});

test("Ctrl+X marks the row and Ctrl+V moves it, once", async () => {
  const { app, tree } = await openExplorer();
  const before = await bytes(app, "README.md");
  await press(await row(tree, "README.md"), "{Control>}x{/Control}");
  expect((await row(tree, "README.md")).getAttribute("aria-description")).toBe("Cut");
  await press(await row(tree, "apps/"), "{Control>}v{/Control}");
  await waitFor(() => expect(tree.querySelector('[data-path="README.md"]')).toBeNull());
  expect(await bytes(app, "apps/README.md")).toBe(before);
  // The cut is used up: there is nothing left to paste.
  await userEvent.pointer({ target: await row(tree, "apps/"), keys: "[MouseRight]" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: /^Paste/ })).toBeNull();
});

test("the menu's Cut and Paste move a file into a folder", async () => {
  const { app, tree } = await openExplorer();
  const before = await bytes(app, "README.md");
  await menuPick(await row(tree, "README.md"), /^Cut/);
  await menuPick(await row(tree, "apps/"), /^Paste/);
  await waitFor(() => expect(tree.querySelector('[data-path="README.md"]')).toBeNull());
  expect(await bytes(app, "apps/README.md")).toBe(before);
});
