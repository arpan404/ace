import { configure, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { expand, openExplorer, row, tabNames } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

async function previewReadme() {
  const opened = await openExplorer();
  await userEvent.click(await row(opened.tree, "README.md"));
  await within(opened.panel).findByRole("tab", { name: "README.md", selected: true });
  const tree = within(opened.panel).getByRole("tree", { name: "Checkout files" });
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  return { ...opened, tree };
}

test("a middle click opens a file in a new tab and keeps the preview it came from", async () => {
  const { panel, tree } = await previewReadme();
  fireEvent(
    await row(tree, "apps/web/src/relay/socket.ts"),
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(panel)).toContain("README.md");
});

test("Ctrl+Enter on a focused row opens it in a new tab; Enter replaces the preview", async () => {
  const { panel, tree } = await previewReadme();
  (await row(tree, "apps/web/src/relay/socket.ts")).focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(panel)).toEqual(expect.arrayContaining(["README.md", "socket.ts"]));
});

test("a plain click still previews in place of the last preview", async () => {
  const { panel, tree } = await previewReadme();
  await userEvent.click(await row(tree, "apps/web/src/relay/socket.ts"));
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  expect(tabNames(panel)).not.toContain("README.md");
});
