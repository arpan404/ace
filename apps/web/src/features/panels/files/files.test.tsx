import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openThread() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  const view = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return { app, view };
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });

async function quickOpen(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  const input = await screen.findByRole("combobox", { name: "Search files" });
  if (text) await userEvent.type(input, text);
  return input;
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
  // Numbered from 1, the numbers in a gutter of their own.
  expect(source.textContent?.startsWith("1import")).toBe(true);
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
  expect(within(list).getByText("Opened recently")).toBeTruthy();
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
  const tree = within(side).getByRole("tree", { name: "Files this thread touched" });
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
  expect(within(side).getByRole("tree", { name: "Files this thread touched" })).toBeTruthy();
});

test("markdown opens rendered, View source shows its lines, and a binary file offers a download", async () => {
  await openThread();
  await quickOpen("README");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  expect(await within(side).findByRole("heading", { name: "relay" })).toBeTruthy();
  await userEvent.click(within(side).getByRole("button", { name: "View source" }));
  const source = await within(side).findByRole("region", { name: "Source of README.md" });
  await waitFor(() => expect(source.textContent).toContain("# relay"));

  await quickOpen("inter.woff2");
  await userEvent.keyboard("{Enter}");
  expect(await within(side).findByText("Binary file")).toBeTruthy();
  expect(within(side).getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
});

test("find in file counts matches and steps through them", async () => {
  await openThread();
  await quickOpen("outbox");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  await within(side).findByRole("region", { name: "Source of apps/web/src/relay/outbox.ts" });
  await userEvent.click(within(side).getByRole("button", { name: "Find in file" }));
  const find = within(side).getByRole("textbox", { name: "Find in file" });
  await userEvent.type(find, "buffer");
  // outbox.ts says "buffer" nine times, MAX_BUFFERED included.
  expect(await within(side).findByText("1 of 9")).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(within(side).getByText("2 of 9")).toBeTruthy();
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}");
  expect(within(side).getByText("9 of 9")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(within(side).queryByRole("textbox", { name: "Find in file" })).toBeNull();
});

test("an upload lands in the checkout and opens; an existing name asks before replacing it", async () => {
  const { app } = await openThread();
  await quickOpen("socket");
  await userEvent.keyboard("{Enter}");
  const side = await panel();
  await within(side).findByRole("tab", { name: "socket.ts", selected: true });

  // The showing tab's tree picks files through its Upload button's input.
  const upload = async (file: File) => {
    const tree = await within(side).findByRole("complementary", { name: "Checkout files" });
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

test("the thread's Files tab is the checkout tree; it opens files beside itself and remembers hiding the tree", async () => {
  await openThread();
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const side = await panel();
  await userEvent.click(within(side).getByRole("tab", { name: "Files" }));
  const tree = await within(side).findByRole("tree", { name: "Files this thread touched" });
  expect(within(side).getByRole("complementary", { name: "Checkout files" })).toBeTruthy();

  // A file picked there opens in a tab of its own: the Files tab stays the tree.
  await userEvent.click(within(tree).getByRole("treeitem", { name: "outbox.ts" }));
  await within(side).findByRole("tab", { name: "outbox.ts", selected: true });
  expect(within(side).getByRole("tab", { name: "Files" })).toBeTruthy();
  // The launcher's Files brings the same tab forward rather than adding another.
  await userEvent.click(within(side).getByRole("button", { name: "New tab" }));
  const tools = await within(side).findByRole("list", { name: "Tools" });
  await userEvent.click(within(tools).getByRole("button", { name: /^Files/ }));
  expect(await within(side).findByRole("tab", { name: "Files", selected: true })).toBeTruthy();
  expect(within(side).getAllByRole("tab", { name: "Files" })).toHaveLength(1);

  await userEvent.click(within(side).getByRole("button", { name: "Hide the file tree" }));
  expect(within(side).queryByRole("complementary", { name: "Checkout files" })).toBeNull();
  // Away and back: the tab kept the choice.
  await userEvent.click(within(side).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(side).getByRole("tab", { name: "Files" }));
  expect(within(side).queryByRole("complementary", { name: "Checkout files" })).toBeNull();
  expect(within(side).getByRole("button", { name: "Show the file tree" })).toBeTruthy();
});
