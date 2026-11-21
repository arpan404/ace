import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { bytes, expand, menuPick, renderTree, row } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

test("New file from a folder's menu is a field inside that folder; Enter makes the file and opens it", async () => {
  const { client, tree, outputs } = await renderTree();
  await menuPick(await row(tree, "apps/"), "New file");
  const field = await within(tree).findByRole("textbox", { name: "New file name" });
  // The field sits inside apps, a level under its row, and no dialog asks for a path.
  expect(field.closest("[role='treeitem']")?.getAttribute("aria-level")).toBe("2");
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.type(field, "notes.md{Enter}");
  await waitFor(() =>
    expect(outputs.opened.at(-1)).toEqual({ path: "apps/notes.md", how: "keep" }),
  );
  expect(await bytes({ client }, "apps/notes.md")).toBe("");
  expect(await row(tree, "apps/notes.md")).toBeTruthy();
  expect(within(tree).queryByRole("textbox")).toBeNull();
});

test("a name already taken says so under the field, which stays for another try", async () => {
  const { tree } = await renderTree();
  const empty = document.querySelector<HTMLElement>('[data-part="tree-root"]');
  if (!empty) throw new Error("No empty tree space");
  await menuPick(empty, "New file");
  const field = await within(tree).findByRole("textbox", { name: "New file name" });
  await userEvent.type(field, "README.md{Enter}");
  expect((await within(tree).findByRole("alert")).textContent).toBe(
    "README.md already exists here. Choose another name.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");
  await userEvent.clear(field);
  await userEvent.type(field, "README2.md{Enter}");
  expect(await row(tree, "README2.md")).toBeTruthy();
});

test("Esc gives up a new entry and nothing is made", async () => {
  const { tree } = await renderTree();
  await menuPick(await row(tree, "apps/"), "New folder");
  const field = await within(tree).findByRole("textbox", { name: "New folder name" });
  await userEvent.type(field, "drafts{Escape}");
  await waitFor(() => expect(within(tree).queryByRole("textbox")).toBeNull());
  expect(tree.querySelector('[data-path="apps/drafts/"]')).toBeNull();
  // The name is still free: making it now meets no clash.
  await menuPick(await row(tree, "apps/"), "New folder");
  await userEvent.type(
    await within(tree).findByRole("textbox", { name: "New folder name" }),
    "drafts{Enter}",
  );
  expect(await row(tree, "apps/drafts/")).toBeTruthy();
  expect(within(tree).queryByRole("alert")).toBeNull();
});

test("a new folder named with slashes makes each folder and shows the last one", async () => {
  const { tree } = await renderTree();
  const empty = document.querySelector<HTMLElement>('[data-part="tree-root"]');
  if (!empty) throw new Error("No empty tree space");
  await menuPick(empty, "New folder");
  await userEvent.type(
    await within(tree).findByRole("textbox", { name: "New folder name" }),
    "drafts/2026{Enter}",
  );
  // The new folder is revealed: its parent opens to show it, selected.
  const made = await row(tree, "drafts/2026/");
  expect(made.getAttribute("aria-selected")).toBe("true");
  expect((await row(tree, "drafts/")).getAttribute("aria-expanded")).toBe("true");
});

test("New file from the explorer's ⋯ starts in the open file's folder", async () => {
  const { tree, outputs } = await renderTree();
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  await userEvent.click(await row(tree, "apps/web/src/relay/socket.ts"));
  const panel = tree.closest("section");
  if (!panel) throw new Error("no panel");
  await userEvent.click(within(panel).getByRole("button", { name: "Manage files" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
  await userEvent.type(
    await within(tree).findByRole("textbox", { name: "New file name" }),
    "inbox.ts{Enter}",
  );
  await waitFor(() =>
    expect(outputs.opened.at(-1)).toEqual({ path: "apps/web/src/relay/inbox.ts", how: "keep" }),
  );
});
