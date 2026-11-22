import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderTree, row } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

test("folders that each hold one folder show as one row, opened and folded together", async () => {
  const { tree, folders } = await renderTree();
  // packages holds only protocol, which holds only src: one row once they are listed.
  await userEvent.click(within(tree).getByRole("treeitem", { name: "packages" }));
  const chain = await within(tree).findByRole("treeitem", { name: "packages/protocol/src" });
  expect(chain.getAttribute("aria-expanded")).toBe("true");
  expect(await row(tree, "packages/protocol/src/events.ts")).toBeTruthy();
  expect(within(tree).queryByRole("treeitem", { name: "protocol" })).toBeNull();
  // Every folder in it is watched, as open folders are.
  await waitFor(() =>
    expect(folders.watches.at(-1)).toEqual(
      expect.arrayContaining(["packages", "packages/protocol", "packages/protocol/src"]),
    ),
  );
  // The row folds as one: its files go, and it stays one row.
  await userEvent.click(chain);
  await waitFor(() => expect(chain.getAttribute("aria-expanded")).toBe("false"));
  expect(tree.querySelector('[data-path="packages/protocol/src/events.ts"]')).toBeNull();
  expect(within(tree).getByRole("treeitem", { name: "packages/protocol/src" })).toBe(chain);
});

test("renaming a compacted row renames its last folder", async () => {
  const { tree } = await renderTree();
  await userEvent.click(within(tree).getByRole("treeitem", { name: "packages" }));
  const chain = await within(tree).findByRole("treeitem", { name: "packages/protocol/src" });
  chain.focus();
  await userEvent.keyboard("{F2}");
  const field = await within(tree).findByRole<HTMLInputElement>("textbox", { name: "Rename src" });
  expect(field.value).toBe("src");
  await userEvent.clear(field);
  await userEvent.type(field, "lib{Enter}");
  expect(await within(tree).findByRole("treeitem", { name: "packages/protocol/lib" })).toBeTruthy();
});
