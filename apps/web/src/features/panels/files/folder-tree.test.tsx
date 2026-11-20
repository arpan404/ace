import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";

async function openFiles(prepare?: (app: ReturnType<typeof harness>) => void) {
  const app = harness();
  const folders = folderFixture(app.client, thread);
  app.play(coldStartReplay()).runThrough("turn-2");
  prepare?.(app);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Editor/ }));
  await within(panel).findByRole("tab", { name: "Editor", selected: true });
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

test("an agent's write re-lists nothing by itself: the watcher names the folder", async () => {
  const { folders } = await openFiles();
  const before = folders.requests.length;
  folders.changedFile("apps/web/agent.ts");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(folders.requests.length).toBe(before);
});

test("this window's move re-lists only the two folders whose rows changed", async () => {
  const { folders, tree } = await openFiles((app) => {
    app.daemon.checkouts.seed(thread, "docs/readme.md", "x\n");
  });
  await userEvent.click(await within(tree).findByRole("treeitem", { name: "docs" }));
  for (const folder of ["apps/", "apps/web/", "apps/web/src/", "apps/web/src/relay/"]) {
    const row = await waitFor(() => {
      const found = tree.querySelector<HTMLElement>(`[data-path="${folder}"]`);
      if (!found) throw new Error(`${folder} is not listed yet`);
      return found;
    });
    if (row.getAttribute("aria-expanded") !== "true") await userEvent.click(row);
  }
  await within(tree).findByRole("treeitem", { name: "outbox.ts" });
  expect(folders.count("apps/web/src/relay")).toBe(1);
  expect(folders.count("docs")).toBe(1);

  const row = await within(tree).findByRole("treeitem", { name: "outbox.ts" });
  row.focus();
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Move" });
  const destination = within(dialog).getByRole("textbox", { name: "Destination path" });
  await userEvent.clear(destination);
  await userEvent.type(destination, "docs/outbox.ts");
  await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await waitFor(() => expect(folders.count("apps/web/src/relay")).toBe(2));
  await waitFor(() => expect(folders.count("docs")).toBe(2));
  expect(folders.count("apps")).toBe(1);
  expect(folders.count("apps/web/src")).toBe(1);
  expect(folders.count("")).toBe(1);
});

test("a search pauses listing; clearing it lists only what changed meanwhile", async () => {
  const { panel, folders, tree } = await openFiles();
  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await within(tree).findByRole("treeitem", { name: "web" });
  expect(folders.count("apps")).toBe(1);
  expect(folders.count("")).toBe(1);

  const filter = within(panel).getByRole("searchbox", { name: "Find files in the checkout" });
  await userEvent.type(filter, "socket");
  await within(panel).findByRole("tree", { name: "Matching files" });
  folders.changed(["apps"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(folders.count("apps")).toBe(1);

  await userEvent.click(within(panel).getByRole("button", { name: "Clear search" }));
  await within(panel).findByRole("tree", { name: "Checkout files" });
  await waitFor(() => expect(folders.count("apps")).toBe(2));
  expect(folders.count("")).toBe(1);
});

test("folding a folder stops watching what it held open, and keeps it for reopening", async () => {
  const { folders, tree } = await openFiles();
  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await userEvent.click(await within(tree).findByRole("treeitem", { name: "web" }));
  await within(tree).findByRole("treeitem", { name: "src" });
  await waitFor(() => expect(folders.watches.at(-1)).toEqual(["", "apps", "apps/web"]));
  const apps = folders.count("apps");
  const web = folders.count("apps/web");

  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await waitFor(() => expect(folders.watches.at(-1)).toEqual([""]));
  folders.changed(["apps/web"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(folders.count("apps/web")).toBe(web);

  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  await waitFor(() => expect(folders.count("apps")).toBe(apps + 1));
  await waitFor(() => expect(folders.count("apps/web")).toBe(web + 1));
  expect(await within(tree).findByRole("treeitem", { name: "src" })).toBeTruthy();
});

test("a stale folder cursor restarts the folder and moves focus to its row", async () => {
  const { panel, folders, tree } = await openFiles();
  folders.failNext("apps", "INVALID_CURSOR");
  const release = folders.hold("apps");
  const apps = within(tree).getByRole("treeitem", { name: "apps" });
  await userEvent.click(apps);
  // Focus moves away while the stale cursor is being retried.
  within(panel).getByRole("searchbox", { name: "Find files in the checkout" }).focus();
  release();
  await within(tree).findByRole("treeitem", { name: "web" });
  expect(folders.count("apps")).toBe(2);
  await waitFor(() => expect(document.activeElement).toBe(apps));
});

test("a folder waiting for its first page is busy and shows a disabled Loading row", async () => {
  const { folders, tree } = await openFiles();
  const release = folders.hold("apps");
  await userEvent.click(within(tree).getByRole("treeitem", { name: "apps" }));
  const loading = await within(tree).findByRole("treeitem", { name: "Loading…" });
  expect(loading.getAttribute("aria-disabled")).toBe("true");
  expect(within(tree).getByRole("treeitem", { name: "apps" }).getAttribute("aria-busy")).toBe(
    "true",
  );
  release();
  await within(tree).findByRole("treeitem", { name: "web" });
  expect(within(tree).getByRole("treeitem", { name: "apps" }).getAttribute("aria-busy")).toBeNull();
});
