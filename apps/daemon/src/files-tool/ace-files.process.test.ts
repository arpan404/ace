// Reason: the daemon's listings, watches and quick open only meet their real edge in a real ace-files process over a real checkout.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemFilesClock } from "@ace/files-native";
import { ThreadId } from "@ace/protocol";
import { FolderWatch, type FoldersChanged } from "./folder-watch.ts";
import { aceFilesIo } from "./io.ts";
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
        {
          id: "phone",
          sendable: () => true,
          valid: () => true,
          send: (message) => inbox.push(message),
        },
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
    await until(async () => (await tool.quickOpen(checkout, "main", 20)).ready);
    await writeFile(join(checkout, "src", "after-start.ts"), "export const later = 1;\n");
    await until(async () =>
      (await tool.quickOpen(checkout, "afterstart", 20)).paths.includes("src/after-start.ts"),
    );
    expect((await tool.quickOpen(checkout, "README", 20)).paths).toContain("README.md");
  });

  it("@ offers a folder with its slash and a bare @ suggests shallow paths", async () => {
    await until(async () => (await tool.quickOpen(checkout, "main", 20)).ready);
    const typed = await tool.quickOpen(checkout, "src", 20);
    expect(typed.paths).toContain("src/");
    expect(typed.paths).toContain("src/main.ts");

    const bare = await tool.quickOpen(checkout, "", 20);
    expect(bare.paths.length).toBeGreaterThan(0);
    expect(bare.paths).toContain("src/");
    // Nothing typed is the same list every time.
    expect((await tool.quickOpen(checkout, "", 20)).paths).toEqual(bare.paths);
  });

  it("answers the quick-open shapes the panel sends", async () => {
    await tool.listFolder(checkout, "");
    // The Rust index ranks like VS Code's quick open; the paths a person expects are the
    // behaviour this guards.
    const expected: [string, string][] = [
      ["main", "src/main.ts"],
      ["gude", "docs/guide.md"],
      ["page3", "docs/page3.md"],
    ];
    for (const [query, path] of expected) {
      const end = Date.now() + 15_000;
      for (;;) {
        const answer = await tool.quickOpen(checkout, query, 20);
        if (answer.paths.includes(path)) break;
        if (Date.now() > end)
          throw new Error(`quick open missed ${path} for ${JSON.stringify(query)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  it("walks a folder of 2,000 entries listed the moment it was populated", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "ace-files-fresh-"));
    try {
      await Promise.all(
        Array.from({ length: 2_000 }, (_, index) =>
          writeFile(join(fresh, `f${String(index).padStart(4, "0")}.txt`), "x"),
        ),
      );
      // Four pages of a folder still inside files-list's racy window: a cursor that needs the
      // folder's stamp would be refused, so a traversal pins its own listing instead.
      const walked: string[] = [];
      for await (const entry of aceFilesIo(tool).walk(fresh, "")) walked.push(entry.path);
      expect(walked).toHaveLength(2_000);
      expect(walked[0]).toBe("f0000.txt");
      expect(walked.at(-1)).toBe("f1999.txt");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
