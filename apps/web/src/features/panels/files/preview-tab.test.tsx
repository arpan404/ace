import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, openExplorer, row, tabNames } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

async function previewReadme() {
  const opened = await openExplorer();
  await userEvent.click(await row(opened.tree, "README.md"));
  const tab = await within(opened.panel).findByRole("tab", { name: "README.md", selected: true });
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  return { ...opened, tree, tab };
}

const title = (tab: HTMLElement) => tab.querySelector<HTMLElement>("[data-tab-title]");

test("a file opened by one click is a preview tab with an italic title", async () => {
  const { tab } = await previewReadme();
  expect(tab.getAttribute("aria-description")).toBe("Preview");
  expect(title(tab)?.className).toContain("italic");
});

test("double-clicking a preview tab keeps it: the next click opens beside it", async () => {
  const { panel, tree, tab } = await previewReadme();
  await userEvent.dblClick(tab);
  expect(tab.getAttribute("aria-description")).toBeNull();
  expect(title(tab)?.className).not.toContain("italic");
  await userEvent.click(await row(tree, "apps/web/src/relay/socket.ts"));
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(panel)).toContain("README.md");
});

test("pinning a preview tab keeps it", async () => {
  const { panel, tree, tab } = await previewReadme();
  await userEvent.pointer({ target: tab, keys: "[MouseRight]" });
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Pin/ }));
  const pinned = await within(panel).findByRole("tab", { name: "README.md" });
  expect(pinned.getAttribute("aria-description")).toBeNull();
  await userEvent.click(await row(tree, "apps/web/src/relay/socket.ts"));
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(panel)).toContain("README.md");
});

test("a double-clicked file opens kept, though its first click swapped in a new tree", async () => {
  const { panel, tree } = await previewReadme();
  await userEvent.click(await row(tree, "apps/web/src/relay/socket.ts"));
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  // The second click lands on the row of the tree the preview's tab mounted.
  const next = within(panel).getByRole("tree", { name: "Checkout files" });
  await userEvent.click(await row(next, "apps/web/src/relay/socket.ts"));
  const tab = within(panel).getByRole("tab", { name: "socket.ts", selected: true });
  expect(tab.getAttribute("aria-description")).toBeNull();
});
