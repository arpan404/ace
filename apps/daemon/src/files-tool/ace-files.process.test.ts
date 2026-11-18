// Reason: the daemon's listings, watches and quick open only meet their real edge in a real ace-files process over a real checkout.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemFilesClock } from "@ace/files-native";
import { ThreadId } from "@ace/protocol";
import { FolderWatch, type FoldersChanged } from "./folder-watch.ts";
import { findFilesBinary, FilesTool } from "./tool.ts";

const binary = findFilesBinary();
const threadId = ThreadId.parse("files-process");

async function until(condition: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > end) throw new Error("timed out waiting for ace-files");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!binary)("ace-files behind the daemon's tool", () => {
  const tool = new FilesTool({ binary, clock: systemFilesClock });
  let checkout = "";

  beforeAll(async () => {
    checkout = await mkdtemp(join(tmpdir(), "ace-files-tool-"));
    await mkdir(join(checkout, "src"), { recursive: true });
    await mkdir(join(checkout, "docs"), { recursive: true });
    await writeFile(join(checkout, "README.md"), "# checkout\n");
    await writeFile(join(checkout, "src", "main.ts"), "export const main = 1;\n");
    await writeFile(join(checkout, "docs", "guide.md"), "guide\n");
    for (const name of ["page1.md", "page2.md", "page3.md", "page4.md", "page5.md"])
      await writeFile(join(checkout, "docs", name), name);
    expect(existsSync(binary ?? "")).toBe(true);
  });

  afterAll(async () => {
    await tool.close();
    if (checkout) await rm(checkout, { recursive: true, force: true });
  });

  it("lists a checkout's folders and files in ace-files' order", async () => {
    const page = await tool.listFolder(checkout, "");
    expect(page.entries.map((entry) => entry.name)).toEqual(["docs", "src", "README.md"]);
    expect(page.entries[0]).toMatchObject({ kind: "directory", path: "docs" });
    expect(page.entries[2]).toMatchObject({ kind: "file", path: "README.md", size: 11 });
    expect(page.nextCursor).toBeNull();

    const nested = await tool.listFolder(checkout, "src");
    expect(nested.entries).toMatchObject([{ name: "main.ts", path: "src/main.ts", kind: "file" }]);
  });

  it("pages a folder without gaps or repeats", async () => {
    // files-list refuses a cursor for a folder whose stamp is under its 2 s racy window.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const first = await tool.listFolder(checkout, "docs", { limit: 2 });
    expect(first.entries.map((entry) => entry.name)).toEqual(["guide.md", "page1.md"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await tool.listFolder(checkout, "docs", {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.entries.map((entry) => entry.name)).toEqual(["page2.md", "page3.md"]);
    expect(first.total).toBe(6);
  });

  it("reports a created file's open folder to a watching client", async () => {
    const inbox: FoldersChanged[] = [];
    const watch = new FolderWatch(
      { watch: (path, onBatch) => tool.watch(path, onBatch) },
      { clock: systemFilesClock },
    );
    try {
      await watch.watch(
        { id: "phone", canSend: () => true, send: (message) => inbox.push(message) },
        threadId,
        checkout,
        ["src"],
      );
      await writeFile(join(checkout, "src", "created.ts"), "export const created = 1;\n");
      await until(() => inbox.some((message) => message.folders.includes("src")));
      expect(inbox).toContainEqual({
        type: "files.folders_changed",
        threadId,
        folders: ["src"],
        rescan: false,
      });
    } finally {
      await watch.close();
    }
  });

  it("quick open finds a file created after the root opened", async () => {
    await tool.listFolder(checkout, "");
    await until(async () => (await tool.quickOpen(checkout, "main", 20)) !== undefined);
    await writeFile(join(checkout, "src", "after-start.ts"), "export const later = 1;\n");
    await until(
      async () =>
        (await tool.quickOpen(checkout, "afterstart", 20))?.includes("src/after-start.ts") === true,
    );
    expect(await tool.quickOpen(checkout, "README", 20)).toContain("README.md");
  });
});
