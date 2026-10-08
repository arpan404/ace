import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = ThreadId.parse("thread-cold-start");
const downloads: { name: string; blob: Blob }[] = [];
const urls = new Map<string, Blob>();
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:download/${urls.size}`;
    if (blob instanceof Blob) urls.set(url, blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = urls.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  urls.clear();
  downloads.length = 0;
});
async function openFiles() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: "Files" }));
  await within(panel).findByRole("treeitem", { name: "README.md" });
  return { app, panel };
}
async function manage(panel: HTMLElement, label: string) {
  await userEvent.click(within(panel).getByRole("button", { name: "Manage files" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: label }));
  return screen.findByRole("dialog", { name: label.replace("…", "") });
}
async function create(panel: HTMLElement, label: "New file" | "New folder", path: string) {
  const dialog = await manage(panel, label);
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Path" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Path" }), path);
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
async function bytes(app: ReturnType<typeof harness>, path: string) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of app.client.downloadFile({ threadId, op: "download", path, offset: 0 }))
    chunks.push(new Uint8Array(chunk));
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}
async function rowKey(panel: HTMLElement, path: string, key: string) {
  const row = await within(panel).findByRole("treeitem", { name: path });
  row.focus();
  await userEvent.keyboard(key);
  return screen.findByRole("dialog");
}

test("a new text file opens for editing and saves the text into the checkout", async () => {
  const { app, panel } = await openFiles();
  await create(panel, "New file", "notes.txt");
  await within(panel).findByRole("tab", { name: "notes.txt", selected: true });
  await userEvent.click(await within(panel).findByRole("button", { name: "Edit file" }));
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "Edit notes.txt" }),
    "My draft",
  );
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() =>
    expect(within(panel).queryByRole("textbox", { name: "Edit notes.txt" })).toBeNull(),
  );
  expect(await bytes(app, "notes.txt")).toBe("My draft");
  expect(await within(panel).findByText("My draft")).toBeTruthy();
});

test("saving a changed file preserves both drafts until Replace is chosen", async () => {
  const { app, panel } = await openFiles();
  await create(panel, "New file", "notes.txt");
  await userEvent.click(await within(panel).findByRole("button", { name: "Edit file" }));
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "Edit notes.txt" }),
    "My edits",
  );
  const stat = await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "stat", path: "notes.txt" },
  });
  if (
    stat.type !== "files.result" ||
    typeof stat.value !== "object" ||
    stat.value === null ||
    !("version" in stat.value) ||
    typeof stat.value.version !== "string"
  )
    throw new Error("No version");
  await app.client.request({
    type: "files.request",
    threadId,
    operation: {
      op: "write",
      path: "notes.txt",
      expected: stat.value.version,
      text: "Agent edits",
    },
  });
  await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
  expect(
    await within(panel).findByText("notes.txt changed since you opened it. Replace it?"),
  ).toBeTruthy();
  expect(await bytes(app, "notes.txt")).toBe("Agent edits");
  expect(
    (within(panel).getByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement).value,
  ).toBe("My edits");
  await userEvent.click(within(panel).getByRole("button", { name: "Replace" }));
  await waitFor(async () => expect(await bytes(app, "notes.txt")).toBe("My edits"));
});

test("new folders appear, F2 renames a file, and the Move shortcut changes its folder", async () => {
  const { app, panel } = await openFiles();
  await create(panel, "New folder", "drafts");
  expect(await within(panel).findByRole("treeitem", { name: "drafts" })).toBeTruthy();
  await create(panel, "New file", "notes.txt");
  let dialog = await rowKey(panel, "notes.txt", "{F2}");
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Path" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Path" }), "plan.txt");
  await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await within(panel).findByRole("treeitem", { name: "plan.txt" })).toBeTruthy();
  expect(within(panel).queryByRole("treeitem", { name: "notes.txt" })).toBeNull();
  dialog = await rowKey(panel, "plan.txt", "{Control>}{Shift>}m{/Shift}{/Control}");
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Destination path" }));
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Destination path" }),
    "drafts/plan.txt",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await bytes(app, "drafts/plan.txt")).toBe("");
  await within(panel).findByRole("tab", { name: "plan.txt", selected: true });
});

test("Delete moves a file to recovery and Undo restores its contents and row", async () => {
  const { app, panel } = await openFiles();
  const before = await bytes(app, "README.md");
  const dialog = await rowKey(panel, "README.md", "{Delete}");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(within(panel).queryByRole("treeitem", { name: "README.md" })).toBeNull(),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await within(panel).findByRole("treeitem", { name: "README.md" })).toBeTruthy();
  expect(await bytes(app, "README.md")).toBe(before);
});

test("a row context menu deletes a folder and Recently deleted restores it without replacing a new file", async () => {
  const { app, panel } = await openFiles();
  await create(panel, "New folder", "drafts");
  await create(panel, "New file", "drafts/notes.txt");
  const row = await within(panel).findByRole("treeitem", { name: "drafts" });
  await userEvent.pointer({ target: row, keys: "[MouseRight]" });
  await userEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
  let dialog = await screen.findByRole("dialog", { name: "Delete" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => {
    if (within(dialog).queryByRole("alert"))
      throw new Error(within(dialog).getByRole("alert").textContent ?? "Delete failed");
    expect(screen.queryByRole("dialog", { name: "Delete" })).toBeNull();
  });
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "create", path: "drafts", expected: null, text: "New file" },
  });
  dialog = await manage(panel, "Recently deleted");
  const deleted = await within(dialog).findByRole("list", { name: "Deleted files" });
  await userEvent.click(await within(deleted).findByRole("button", { name: "Restore" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(await bytes(app, "drafts")).toBe("New file");
  const stat = await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "stat", path: "drafts" },
  });
  if (
    stat.type !== "files.result" ||
    typeof stat.value !== "object" ||
    stat.value === null ||
    !("version" in stat.value) ||
    typeof stat.value.version !== "string"
  )
    throw new Error("No version");
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "delete", path: "drafts", expected: stat.value.version },
  });
  await userEvent.click(within(deleted).getByRole("button", { name: "Restore" }));
  await waitFor(async () => expect(await bytes(app, "drafts/notes.txt")).toBe(""));
});

test("folder downloads show count and size, include ignored files when chosen, and save an archive", async () => {
  const { panel } = await openFiles();
  const dialog = await manage(panel, "Download folder…");
  const count = await within(dialog).findByRole("status");
  await waitFor(() => expect(count.textContent).toMatch(/\d+ entries · .+ before compression/));
  const entries = Number(count.textContent?.split(" ")[0]);
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "Include ignored files" }));
  await waitFor(() => expect(count.textContent).toContain(`${entries + 2} entries`));
  await userEvent.click(within(dialog).getByRole("button", { name: "Download" }));
  await waitFor(() => {
    if (within(dialog).queryByRole("alert"))
      throw new Error(within(dialog).getByRole("alert").textContent ?? "Download failed");
    expect(downloads).toHaveLength(1);
  });
  expect(downloads[0]?.name).toBe("checkout.tar.gz");
  const archive = await downloads[0]?.blob.arrayBuffer();
  if (!archive) throw new Error("No archive");
  const body = new Response(archive).body;
  if (!body) throw new Error("No archive stream");
  expect(
    new TextDecoder().decode(
      await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    ),
  ).toContain("Ignored build output");
});

test("closing a file with edits asks before discarding them", async () => {
  const { app, panel } = await openFiles();
  await create(panel, "New file", "notes.txt");
  await userEvent.click(await within(panel).findByRole("button", { name: "Edit file" }));
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "Edit notes.txt" }),
    "Unsaved draft",
  );
  await userEvent.click(within(panel).getByRole("button", { name: "Close notes.txt" }));
  const confirmation = await screen.findByRole("dialog", { name: "Discard file edits?" });
  await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(
    (within(panel).getByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement).value,
  ).toBe("Unsaved draft");
  await userEvent.click(within(panel).getByRole("button", { name: "Close notes.txt" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Discard file edits?" })).getByRole("button", {
      name: "Discard",
    }),
  );
  await waitFor(() => expect(within(panel).queryByRole("tab", { name: "notes.txt" })).toBeNull());
  expect(await bytes(app, "notes.txt")).toBe("");
});
