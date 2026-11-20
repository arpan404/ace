import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { bytes, expand, menuPick, openExplorer, row, tabNames } from "./explorer-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

afterEach(() => vi.restoreAllMocks());

test("a file row's menu opens it in a new tab and keeps the tab it came from", async () => {
  const { panel, tree } = await openExplorer();
  await userEvent.click(await row(tree, "README.md"));
  await within(panel).findByRole("tab", { name: "README.md", selected: true });
  const tree2 = within(panel).getByRole("tree", { name: "Checkout files" });
  await expand(tree2, ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  await menuPick(await row(tree2, "apps/web/src/relay/socket.ts"), /^Open in new tab/);
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  // The preview README.md came from stays: a new tab never replaces one.
  expect(tabNames(panel)).toContain("README.md");
});

test("Shift+F10 opens a row's menu, each action showing its shortcut", async () => {
  const { tree } = await openExplorer();
  (await row(tree, "README.md")).focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: /^Rename/ }).textContent).toContain("F2");
  const newTab = within(menu).getByRole("menuitem", { name: /^Open in new tab/ });
  expect(newTab.textContent).toMatch(/Ctrl\+(Enter|↵)$/);
});

test("a folder row's New file starts in that folder", async () => {
  const { tree } = await openExplorer();
  await menuPick(await row(tree, "apps/"), "New file…");
  const dialog = await screen.findByRole("dialog", { name: "New file" });
  expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Path" }).value).toBe(
    "apps/",
  );
});

test("Duplicate copies a file beside it as 'name copy' with the same contents", async () => {
  const { app, tree } = await openExplorer();
  const before = await bytes(app, "README.md");
  await menuPick(await row(tree, "README.md"), "Duplicate");
  expect(await row(tree, "README copy.md")).toBeTruthy();
  expect(await bytes(app, "README copy.md")).toBe(before);
  await menuPick(await row(tree, "README.md"), "Duplicate");
  expect(await row(tree, "README copy 2.md")).toBeTruthy();
});

test("Duplicate copies a folder and everything in it", async () => {
  const { app, tree } = await openExplorer();
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/"]);
  await menuPick(await row(tree, "apps/web/src/relay/"), "Duplicate");
  const copy = await row(tree, "apps/web/src/relay copy/");
  await userEvent.click(copy);
  await row(tree, "apps/web/src/relay copy/socket.ts");
  expect(await bytes(app, "apps/web/src/relay copy/socket.ts")).toBe(
    await bytes(app, "apps/web/src/relay/socket.ts"),
  );
});

test("Copy path copies the checkout path and Copy relative path the path inside it", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
  });
  const { tree } = await openExplorer();
  await expand(tree, ["apps/"]);
  await menuPick(await row(tree, "apps/web/"), "Copy relative path");
  await waitFor(() => expect(written.at(-1)).toBe("apps/web"));
  await menuPick(await row(tree, "apps/web/"), "Copy path");
  await waitFor(() => expect(written.at(-1)).toMatch(/^\/.+\/apps\/web$/));
});

test("Mention in chat puts the file in the thread's message", async () => {
  const { tree } = await openExplorer();
  await menuPick(await row(tree, "README.md"), "Mention in chat");
  const message = screen.getByRole("combobox", { name: "Message" });
  await waitFor(() => expect(message.textContent).toContain("@README.md"));
});

test("Find in folder searches file contents inside that folder", async () => {
  const { panel, tree } = await openExplorer();
  await menuPick(await row(tree, "apps/"), /^Find in folder/);
  const include = await within(panel).findByRole<HTMLInputElement>("textbox", {
    name: "Files to include",
  });
  expect(include.value).toBe("apps/**");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(panel).getByRole("searchbox", { name: "Search file contents" }),
    ),
  );
});

test("Collapse folders below folds the folders inside and leaves the folder open", async () => {
  const { tree } = await openExplorer();
  await expand(tree, ["apps/", "apps/web/", "apps/web/src/"]);
  await menuPick(await row(tree, "apps/"), "Collapse folders below");
  await waitFor(() => expect(tree.querySelector('[data-path="apps/web/src/"]')).toBeNull());
  expect((await row(tree, "apps/")).getAttribute("aria-expanded")).toBe("true");
  expect((await row(tree, "apps/web/")).getAttribute("aria-expanded")).toBe("false");
});

test("the tree's empty space acts on the checkout's root", async () => {
  const { panel } = await openExplorer();
  const empty = panel.querySelector<HTMLElement>('[data-part="tree-root"]');
  if (!empty) throw new Error("No empty tree space");
  await menuPick(empty, "New folder…");
  const dialog = await screen.findByRole("dialog", { name: "New folder" });
  expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Path" }).value).toBe("");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await userEvent.pointer({ target: empty, keys: "[MouseRight]" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: /^Rename/ })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: "Collapse all folders" })).toBeTruthy();
});

test("Reveal shows the file in the machine's file manager when ace runs on this computer", async () => {
  const { app, tree } = await openExplorer();
  const opened: unknown[] = [];
  const request = app.client.request.bind(app.client);
  vi.spyOn(app.client, "request").mockImplementation((input, options) => {
    if (input.type === "workspace.request" && input.operation.op === "host.open")
      opened.push(input.operation);
    return request(input, options);
  });
  await menuPick(await row(tree, "README.md"), /^Reveal in /);
  await waitFor(() =>
    expect(opened).toEqual([
      expect.objectContaining({ app: { kind: "files" }, path: "README.md" }),
    ]),
  );
});
