import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";

async function openFiles() {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  await within(panel).findByRole("tab", { name: "Files", selected: true });
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  await within(tree).findByRole("treeitem", { name: "README.md" });
  return { app, panel, folders, tree };
}

test("the root lists once and a folder is listed only when it opens", async () => {
  const { folders, tree } = await openFiles();
  expect(folders.count("")).toBe(1);
  expect(folders.count("apps")).toBe(0);

  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  expect(await within(tree).findByRole("treeitem", { name: "web" })).toBeTruthy();
  expect(folders.count("apps")).toBe(1);
  // Watched now that it is open; nothing below it has been listed.
  await waitFor(() => expect(folders.watches.at(-1)).toEqual(["", "apps"]));
  expect(folders.count("apps/web")).toBe(0);

  // Folding it fetches nothing and stops watching it.
  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await waitFor(() => expect(folders.watches.at(-1)).toEqual([""]));
  folders.changed(["apps"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(folders.count("apps")).toBe(1);
  expect(within(tree).queryByRole("treeitem", { name: "web" })).toBeNull();

  // Opening it again lists it again.
  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await within(tree).findByRole("treeitem", { name: "web" });
  expect(folders.count("apps")).toBe(2);
});

test("a pushed folders_changed re-lists only the open folder, and a rescan lists every open one", async () => {
  const { folders, tree } = await openFiles();
  const apps = await within(tree).findByRole("treeitem", { name: "apps" });
  await userEvent.click(apps);
  await userEvent.click(await within(tree).findByRole("treeitem", { name: "web" }));
  await within(tree).findByRole("treeitem", { name: "src" });
  expect(folders.count("apps")).toBe(1);
  expect(folders.count("apps/web")).toBe(1);

  folders.changed(["apps"]);
  await waitFor(() => expect(folders.count("apps")).toBe(2));
  expect(folders.count("apps/web")).toBe(1);
  expect(apps.getAttribute("aria-expanded")).toBe("true");
  expect(within(tree).getByRole("treeitem", { name: "web" })).toBeTruthy();

  folders.changed([], true);
  await waitFor(() => expect(folders.count("apps")).toBe(3));
  await waitFor(() => expect(folders.count("apps/web")).toBe(2));
  await waitFor(() => expect(folders.count("")).toBe(2));
});

test("opening a file elsewhere opens and lists each of its folders on the way", async () => {
  const { panel, folders } = await openFiles();
  await userEvent.keyboard("{Control>}p{/Control}");
  const search = await screen.findByRole("combobox", { name: "Search files" });
  await userEvent.type(search, "socket");
  await userEvent.keyboard("{Enter}");
  await within(panel).findByRole("tab", { name: "socket.ts", selected: true });
  const tree = await within(panel).findByRole("tree", { name: "Checkout files" });
  const row = await within(tree).findByRole("treeitem", { name: "socket.ts" });
  expect(row.getAttribute("data-state")).toBe("selected");
  for (const folder of ["apps", "apps/web", "apps/web/src", "apps/web/src/relay"])
    expect(folders.count(folder), folder).toBe(1);
});

test("ignored entries are listed, dimmed, and still open", async () => {
  const { app, folders, tree } = await openFiles();
  app.daemon.checkouts.seed(thread, "dist/old.js", "x\n");
  folders.ignore(["dist/old.js"]);
  folders.changed([], true);
  const dist = await within(tree).findByRole("treeitem", { name: "dist" });
  await userEvent.click(dist);
  const row = await within(tree).findByRole("treeitem", { name: "old.js" });
  expect(row.getAttribute("data-ignored")).toBe("true");
  expect(row.className).toContain("text-muted-foreground");
});
