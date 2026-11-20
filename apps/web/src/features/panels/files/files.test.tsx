import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

configure({ asyncUtilTimeout: 10000 });

async function openThread() {
  const app = harness();
  const folders = folderFixture(app.client, "thread-cold-start");
  app.play(coldStartReplay()).runThrough("turn-2");
  const view = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return { app, view, folders };
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });

async function quickOpen(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  const input = await screen.findByRole("combobox", { name: "Search files" });
  if (text) await userEvent.type(input, text);
  return input;
}

/** Folders start folded: open each of `folders` in `tree` so a nested file shows. */
async function reveal(tree: HTMLElement, folders: readonly string[]) {
  for (const folder of folders) {
    const row = await waitFor(() => {
      const found = tree.querySelector<HTMLElement>(`[data-path="${folder}"]`);
      if (!found) throw new Error(`${folder} is not listed yet`);
      return found;
    });
    if (row.getAttribute("aria-expanded") !== "true") await userEvent.click(row);
  }
}

async function readCheckout(app: ReturnType<typeof harness>, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({
    threadId: ThreadId.parse("thread-cold-start"),
    op: "download",
    path,
    offset: 0,
  }))
    chunks.push(chunk);
  return new TextDecoder().decode(
    await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).arrayBuffer(),
  );
}

test("⌘P finds a checkout file by a few letters and opens it with numbered source lines", async () => {
  await openThread();
  await quickOpen("sock");
  const option = await screen.findByRole("option", { name: /socket\.ts/ });
  expect(option.getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{Enter}");

  const side = await panel();
  expect(within(side).getByRole("tab", { name: "socket.ts", selected: true })).toBeTruthy();
  const source = await within(side).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket {"));
  // The path stays in the toolbar as a breadcrumb, the file last.
  const crumbs = within(side).getByRole("navigation", { name: "File path" });
  expect(within(crumbs).getByText("socket.ts").getAttribute("aria-current")).toBe("page");
  // Focus went back to where it was: the palette is gone.
  expect(screen.queryByRole("combobox", { name: "Search files" })).toBeNull();
});

test("quick open lists files opened recently and files the thread edited before anything is typed", async () => {
  await openThread();
  await quickOpen("socket");
  await userEvent.keyboard("{Enter}");
  await within(await panel()).findByRole("tab", { name: "socket.ts" });

  await quickOpen("");
  const list = screen.getByRole("listbox", { name: "Files" });
  // socket.ts is open in a tab, so it leads as an open editor.
  expect(within(list).getByText("Open editors")).toBeTruthy();
  expect(within(list).getByText("Edited in this thread")).toBeTruthy();
  expect(within(list).getByRole("option", { name: /socket\.ts/ })).toBeTruthy();
  expect(within(list).getByRole("option", { name: /replay\.ts/ })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Files" })).toBeNull();
});

test("a click in the tree previews a file in place; a kept tab stays", async () => {
  await openThread();
  await quickOpen("replay.ts");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  await within(side).findByRole("tab", { name: "replay.ts", selected: true });

  // replay.ts was opened deliberately, so a click in its tree opens a preview beside it.
  // outbox.ts lives in another subtree, folded by default: reveal it first.
  const tree = within(side).getByRole("tree", { name: "Checkout files" });
  await reveal(tree as HTMLElement, ["apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  await userEvent.click(within(tree).getByRole("treeitem", { name: "outbox.ts" }));
  await within(side).findByRole("tab", { name: "outbox.ts", selected: true });

  // A file found by the filter takes the preview's place rather than adding a tab.
  await userEvent.type(
    within(side)
      .getAllByRole("searchbox", { name: "Find files in the checkout" })
      .at(-1) as HTMLElement,
    "socket",
  );
  const found = await within(side).findByRole("tree", { name: "Matching files" });
  await userEvent.click(await within(found).findByRole("treeitem", { name: "socket.ts" }));
  await within(side).findByRole("tab", { name: "socket.ts", selected: true });
  const names = within(side)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
  expect(names).toContain("replay.ts");
  expect(names).not.toContain("outbox.ts");
});

test("the tree's filter says when nothing in the checkout matches", async () => {
  await openThread();
  await quickOpen("replay.ts");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  const filter = (
    await within(side).findAllByRole("searchbox", { name: "Find files in the checkout" })
  )[0];
  if (!filter) throw new Error("no filter");
  await userEvent.type(filter, "zzqx");
  expect(await within(side).findByText("No files match “zzqx”.")).toBeTruthy();
  await userEvent.click(within(side).getByRole("button", { name: "Clear search" }));
  expect(within(side).getByRole("tree", { name: "Checkout files" })).toBeTruthy();
});

test("an upload lands in the checkout and opens; an existing name asks before replacing it", async () => {
  const { app } = await openThread();
  await quickOpen("socket");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  await within(side).findByRole("tab", { name: "socket.ts", selected: true });

  // The showing tab's tree picks files through its Upload button's input.
  const upload = async (file: File) => {
    const tree = await within(side).findByRole("complementary", { name: "Explorer" });
    const input = tree.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no upload input");
    await userEvent.upload(input, file);
  };
  await upload(new File(["first draft\n"], "notes.md", { type: "text/markdown" }));
  await within(side).findByRole("tab", { name: "notes.md", selected: true });
  expect(await readCheckout(app, "apps/web/src/relay/notes.md")).toBe("first draft\n");

  await upload(new File(["second draft\n"], "notes.md", { type: "text/markdown" }));
  expect(
    await within(side).findByText("apps/web/src/relay/notes.md already exists. Replace it?"),
  ).toBeTruthy();
  // Nothing was overwritten yet.
  expect(await readCheckout(app, "apps/web/src/relay/notes.md")).toBe("first draft\n");
  await userEvent.click(within(side).getByRole("button", { name: "Replace" }));
  await waitFor(async () =>
    expect(await readCheckout(app, "apps/web/src/relay/notes.md")).toBe("second draft\n"),
  );
});

test("a checkout of hundreds of files lists one folder at a time, and search finds any", async () => {
  const { app } = await openThread();
  for (let n = 0; n < 400; n++)
    app.daemon.checkouts.seed("thread-cold-start", `pkg/part-${n % 20}/case-${n}.ts`, "x\n");
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const side = await panel();
  await userEvent.click(within(side).getByRole("button", { name: "New tab" }));
  const tools = await within(side).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Deck/ }));
  const tree = await within(side).findByRole("tree", { name: "Checkout files" });
  // The root lists the checkout's top folders only: nothing below is asked for until it opens.
  const pkg = await within(tree).findByRole("treeitem", { name: "pkg" });
  expect(within(tree).queryByRole("treeitem", { name: "part-0" })).toBeNull();
  await reveal(tree as HTMLElement, ["pkg/", "pkg/part-0/"]);
  expect(await within(tree).findByRole("treeitem", { name: "case-0.ts" })).toBeTruthy();
  await userEvent.type(
    within(side).getByRole("searchbox", { name: "Find files in the checkout" }),
    "case-399",
  );
  const found = await within(side).findByRole("tree", { name: "Matching files" });
  expect(await within(found).findByRole("treeitem", { name: "case-399.ts" })).toBeTruthy();
  expect(pkg.getAttribute("aria-expanded")).toBe("true");
});

test("an open file shows what another program wrote to it, once the watcher names its folder", async () => {
  const { app, folders } = await openThread();
  await quickOpen("sock");
  await screen.findByRole("option", { name: /socket\.ts/ });
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  const source = await within(side).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket {"));
  // The daemon only names folders a client watches: the open file's folder is one of them.
  await waitFor(() => expect(folders.watches.at(-1)).toContain("apps/web/src/relay"));

  app.daemon.checkouts.overwrite(
    "thread-cold-start",
    "apps/web/src/relay/socket.ts",
    "export const fromDisk = 1;\n",
  );
  folders.changed(["apps/web/src/relay"]);
  await waitFor(() =>
    expect(
      within(side).getByRole("region", { name: "Source of apps/web/src/relay/socket.ts" })
        .textContent,
    ).toContain("fromDisk"),
  );
});

test("a write that lands after the file was read but before its folder is watched still shows", async () => {
  const { app, folders } = await openThread();
  const path = "apps/web/src/relay/socket.ts";
  let readFirst = false;
  // The shell writes in the gap: the file was already read, the daemon is not watching yet.
  folders.onWatch((watched) => {
    if (readFirst || !watched.includes("apps/web/src/relay")) return;
    readFirst = document.body.textContent?.includes("export class RelaySocket {") ?? false;
    app.daemon.checkouts.overwrite("thread-cold-start", path, "export const fromDisk = 1;\n");
  });
  await quickOpen("sock");
  await screen.findByRole("option", { name: /socket\.ts/ });
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  await waitFor(() => expect(readFirst).toBe(true));
  // No change notice comes for that write: the watch went in after it.
  await waitFor(() =>
    expect(within(side).getByRole("region", { name: `Source of ${path}` }).textContent).toContain(
      "fromDisk",
    ),
  );
});
