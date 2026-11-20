import { configure, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, openExplorer, row } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const focused = () => document.activeElement?.getAttribute("data-path");
const rootRows = (tree: HTMLElement) =>
  [...tree.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]')].map((each) =>
    each.getAttribute("data-path"),
  );

test("Right opens a folder then enters it, Left goes back to the folder then closes it", async () => {
  const { tree } = await openExplorer();
  (await row(tree, "apps/")).focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(tree.querySelector('[data-path="apps/"]')?.getAttribute("aria-expanded")).toBe("true"),
  );
  await row(tree, "apps/server/");
  await userEvent.keyboard("{ArrowRight}");
  expect(focused()).toMatch(/^apps\/[^/]+\/$/);
  await userEvent.keyboard("{ArrowLeft}");
  expect(focused()).toBe("apps/");
  await userEvent.keyboard("{ArrowLeft}");
  await waitFor(() => expect(tree.querySelector('[data-path="apps/server/"]')).toBeNull());
  expect(focused()).toBe("apps/");
});

test("Home and End go to the first and last rows", async () => {
  const { tree } = await openExplorer();
  (await row(tree, "README.md")).focus();
  await userEvent.keyboard("{Home}");
  expect(focused()).toBe(rootRows(tree)[0]);
  await userEvent.keyboard("{End}");
  expect(focused()).toBe(rootRows(tree).at(-1));
});

test("typing a name jumps to the next row that starts with it", async () => {
  const { tree } = await openExplorer();
  (await row(tree, "apps/")).focus();
  await userEvent.keyboard("rea");
  expect(focused()).toBe("README.md");
  // After a pause the letters start a new name.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await userEvent.keyboard("a");
  expect(focused()).toBe("apps/");
});

test("rows say how deep they are and where they sit among their siblings", async () => {
  const { tree } = await openExplorer();
  await expand(tree, ["apps/"]);
  const roots = rootRows(tree);
  const apps = await row(tree, "apps/");
  expect(apps.getAttribute("aria-setsize")).toBe(String(roots.length));
  expect(apps.getAttribute("aria-posinset")).toBe(String(roots.indexOf("apps/") + 1));
  const children = [...tree.querySelectorAll('[role="treeitem"][aria-level="2"]')];
  const server = await row(tree, "apps/server/");
  expect(server.getAttribute("aria-level")).toBe("2");
  expect(server.getAttribute("aria-setsize")).toBe(String(children.length));
  expect(server.getAttribute("aria-posinset")).toBe(String(children.indexOf(server) + 1));
});
