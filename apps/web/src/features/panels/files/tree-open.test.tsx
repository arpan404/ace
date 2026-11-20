import { configure, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, openExplorer, row, tabNames } from "./explorer-test-support.ts";
import { renderTree } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

const socket = "apps/web/src/relay/socket.ts";
const relay = ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"];

test("a middle click opens a file in a new tab and keeps the preview it came from", async () => {
  const opened = await openExplorer();
  await userEvent.click(await row(opened.tree, "README.md"));
  await within(opened.panel).findByRole("tab", { name: "README.md", selected: true });
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  await expand(tree, relay);
  fireEvent(await row(tree, socket), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  await within(opened.panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(opened.panel)).toContain("README.md");
});

test("Ctrl+Enter on a focused row opens it in a new tab; Enter keeps it, Space previews", async () => {
  const { tree, outputs } = await renderTree();
  await expand(tree, relay);
  (await row(tree, socket)).focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  (await row(tree, "README.md")).focus();
  await userEvent.keyboard("{Enter}");
  (await row(tree, socket)).focus();
  await userEvent.keyboard(" ");
  expect(outputs.opened).toEqual([
    { path: socket, how: "tab" },
    { path: "README.md", how: "keep" },
    { path: socket, how: "preview" },
  ]);
});

test("a plain click on a file previews it", async () => {
  const { tree, outputs } = await renderTree();
  await expand(tree, relay);
  await userEvent.click(await row(tree, "README.md"));
  // The tab puts a preview in the last one's place (preview-tab.test.tsx).
  await userEvent.click(await row(tree, socket));
  expect(outputs.opened).toEqual([
    { path: "README.md", how: "preview" },
    { path: socket, how: "preview" },
  ]);
});
