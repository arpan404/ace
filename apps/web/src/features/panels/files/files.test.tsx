import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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
  const tree = within(side).getByRole("tree", { name: "Checkout files" });
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
  const tree = await within(side).findByRole("tree", { name: "Checkout files" });
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

test("a selected source range is mentioned inline and sends only those lines", async () => {
  const { app } = await openThread();
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context?.mentions);
    return receive(command);
  };
  await quickOpen("socket");
  await userEvent.keyboard("{Enter}");
  const source = await within(await panel()).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket"));
  // Select the visible source words exactly as a mouse drag does.
  const walk = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const words: Text[] = [];
  while (walk.nextNode()) if (walk.currentNode instanceof Text) words.push(walk.currentNode);
  const first = words.find((node) => node.textContent?.includes("import"));
  const last = words.find((node) => node.textContent?.includes("RelaySocket"));
  if (!first || !last) throw new Error("Source words are missing");
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.mouseUp(source);
  const action = await screen.findByRole("button", { name: /Mention selection · lines 1–/ });
  const end = Number(action.textContent?.split("–").at(-1));
  await userEvent.click(action);
  const message = screen.getByRole("combobox", { name: "Message" });
  expect(message.textContent).toContain(`@apps/web/src/relay/socket.ts:1-${end}`);
  await userEvent.type(message, "Explain this{Enter}");
  await waitFor(() =>
    expect(sent.at(-1)).toEqual([
      { path: "apps/web/src/relay/socket.ts", lines: { start: 1, end } },
    ]),
  );
});

test("a source file offers only installed editors and opens its checkout path", async () => {
  const { app } = await openThread();
  app.daemon.workspace.setEditors([{ id: "zed", name: "Zed", command: "zed" }]);
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  try {
    await quickOpen("socket");
    await userEvent.keyboard("{Enter}");
    const side = await panel();
    const launch = await within(side).findByRole("button", { name: "Open in Zed" });
    expect(launch.querySelector('[data-app-icon="zed"]')).toBeTruthy();
    await userEvent.click(within(side).getByRole("button", { name: "Open in another editor" }));
    expect(await screen.findByRole("menuitem", { name: /^Zed/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Visual Studio Code/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(launch);
    await waitFor(() =>
      expect(launched).toHaveBeenCalledWith(
        "zed://file/Users/dev/ace/apps/web/src/relay/socket.ts",
        "_self",
      ),
    );
  } finally {
    launched.mockRestore();
  }
});
