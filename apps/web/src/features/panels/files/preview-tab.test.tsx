import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { openExplorer, row, tabNames } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

/** Preview README.md from the Files tab; package.json sits beside it at the root. */
async function previewReadme() {
  const opened = await openExplorer();
  await userEvent.click(await row(opened.tree, "README.md"));
  const tab = await within(opened.panel).findByRole("tab", { name: "README.md", selected: true });
  // The preview's tab mounts its own tree.
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  return { ...opened, tree, tab };
}

const title = (tab: HTMLElement) => tab.querySelector<HTMLElement>("[data-tab-title]");

test("one click previews a file in the last preview's place; a second click keeps it", async () => {
  const { panel, tree, tab } = await previewReadme();
  expect(tab.getAttribute("aria-description")).toBe("Preview");
  expect(title(tab)?.className).toContain("italic");
  await userEvent.click(await row(tree, "package.json"));
  await within(panel).findByRole("tab", { name: "package.json", selected: true });
  expect(tabNames(panel)).not.toContain("README.md");
  // The second click lands on the row of the tree the preview's tab mounted.
  const next = within(panel).getByRole("tree", { name: "Checkout files" });
  await userEvent.click(await row(next, "package.json"));
  const kept = within(panel).getByRole("tab", { name: "package.json", selected: true });
  expect(kept.getAttribute("aria-description")).toBeNull();
  expect(title(kept)?.className).not.toContain("italic");
});

test("double-clicking a preview tab keeps it: the next click opens beside it", async () => {
  const { panel, tree, tab } = await previewReadme();
  await userEvent.dblClick(tab);
  expect(tab.getAttribute("aria-description")).toBeNull();
  expect(title(tab)?.className).not.toContain("italic");
  await userEvent.click(await row(tree, "package.json"));
  await within(panel).findByRole("tab", { name: "package.json", selected: true });
  expect(tabNames(panel)).toContain("README.md");
});

test("pinning a preview tab keeps it", async () => {
  const { panel, tree, tab } = await previewReadme();
  await userEvent.pointer({ target: tab, keys: "[MouseRight]" });
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Pin/ }));
  const pinned = await within(panel).findByRole("tab", { name: "README.md" });
  expect(pinned.getAttribute("aria-description")).toBeNull();
  await userEvent.click(await row(tree, "package.json"));
  await within(panel).findByRole("tab", { name: "package.json", selected: true });
  expect(tabNames(panel)).toContain("README.md");
});
