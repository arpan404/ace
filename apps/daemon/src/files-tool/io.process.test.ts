// Reason: a client must see byte-identical replies whether ace-files or the TypeScript path answers
// its file operations, and only two real services over one real checkout prove that.
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesService, type Download } from "@ace/files";
import { systemFilesClock } from "@ace/files-native";
import { aceFilesIo } from "./io.ts";
import { findFilesBinary, FilesTool } from "./tool.ts";

const binary = findFilesBinary();
const execFile = promisify(execFileCallback);

/** A version string anywhere in a reply, whichever side produced it. */
const versioned = expect.stringMatching(
  /^(tree:[0-9a-f]{64}|-?[\d.]+:-?[\d.]+:-?[\d.]+:-?[\d.]+:-?[\d.]+)$/,
);

/** Recorded from the TypeScript path before the cutover; both paths must still answer this. */
const recorded = {
  statFile: { path: "notes.md", version: versioned, size: 13, type: "file" },
  statFolder: { path: "docs", version: versioned, type: "directory" },
  statMissing: { path: "gone.md", version: null },
  readPart: {
    path: "notes.md",
    version: versioned,
    type: "file",
    size: 13,
    offset: 0,
    encoding: "identity",
    data: Buffer.from("hello, world\n").toString("base64"),
  },
  readFolder: { path: "docs", version: "directory", type: "directory" },
  readMissing: { path: "gone.md", version: null },
  created: { op: "create", path: "fresh.md", version: versioned },
  folder: { op: "mkdir", path: "made", version: versioned },
} as const;

type Answer =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; current: string | null };

/** What a reply must be: the value it carried, or the failure it named. */
function value(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`expected a result, got ${answer.code}`);
  return answer.value;
}

function failure(answer: Answer): { code: string; current: string | null } {
  if (answer.ok) throw new Error("expected a failure, got a result");
  return answer;
}

/** A failure in the shape the comparisons use. */
function failed(error: unknown): Answer {
  return {
    ok: false,
    code: error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN",
    current:
      (error instanceof Error ? (error as { current?: string | null }).current : undefined) ?? null,
  };
}

function collected(): number {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
  bun?.gc(true);
  return process.memoryUsage().rss;
}

async function preview(
  target: FilesService,
  path: string,
): Promise<{ previewId: string; bytes: number; entries: number; format: string }> {
  return (await target.request("owner", {
    op: "archive.preview",
    path,
    includeIgnored: false,
  })) as {
    previewId: string;
    bytes: number;
    entries: number;
    format: string;
  };
}

/** The tar's members, by name, so two archives compare whatever order they were written in. */
async function archiveMembers(
  target: FilesService,
  previewId: string,
): Promise<Map<string, string>> {
  const archive = await target.download("owner", { op: "archive.download", previewId });
  const tar = gunzipSync(await drain(archive));
  const found = new Map<string, string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replaceAll("\0", "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString().replaceAll("\0", "").trim() || "0",
      8,
    );
    found.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

async function drain(download: Download): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of download.chunks) parts.push(part);
  return Buffer.concat(parts);
}

/** A service over one checkout: `workspaceIo` left out means the TypeScript path answers. */
function service(workspace: string, dataDir: string, options: object = {}): Promise<FilesService> {
  return FilesService.create({
    workspace,
    dataDir,
    now: Date.now,
    id: () => crypto.randomUUID(),
    authorize: () => true,
    ...options,
  });
}

function ask(target: FilesService, operation: unknown): Promise<Answer> {
  return target
    .request("owner", operation)
    .then((result) => ({ ok: true as const, value: result as Record<string, unknown> }), failed);
}

function openDownload(target: FilesService, operation: unknown): Promise<Answer> {
  return target
    .download("owner", operation)
    .then((opened) => ({ ok: true as const, value: { ...opened, chunks: undefined } }), failed);
}

describe.skipIf(!binary)("the daemon's file operations answered by ace-files", () => {
  const tool = new FilesTool({ binary, clock: systemFilesClock });
  let home = "";
  let root = "";
  let local: FilesService;
  let native: FilesService;

  /** The same request through both services, one after the other: replies must be equal. */
  async function both(operation: unknown): Promise<Answer> {
    const byTs = await ask(local, operation);
    const byRust = await ask(native, operation);
    expect(byRust).toEqual(byTs);
    return byRust;
  }

  /** The same download request through both services: replies must be equal. */
  async function bothDownloads(operation: unknown): Promise<Answer> {
    const byTs = await openDownload(local, operation);
    const byRust = await openDownload(native, operation);
    expect(byRust).toEqual(byTs);
    return byRust;
  }

  /** The version the TypeScript path reports for a path today. */
  async function version(path: string): Promise<string> {
    return String(value(await ask(local, { op: "stat", path })).version);
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "ace-files-io-"));
    root = join(home, "checkout");
    await mkdir(join(root, "docs", "nested"), { recursive: true });
    await execFile("git", ["init", "-q", root]);
    await writeFile(join(root, "notes.md"), "hello, world\n");
    await writeFile(join(root, "docs", "guide.md"), "guide\n");
    await writeFile(join(root, "docs", "nested", "deep.md"), "deep\n");
    await writeFile(join(root, "docs", ".gitignore"), "secret.md\n");
    await writeFile(join(root, "docs", "secret.md"), "secret\n");
    await writeFile(join(root, "large.bin"), Buffer.alloc(4096, 7));
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "escape"));
    await symlink("guide.md", join(root, "docs", "link.md"));
    await symlink(join(outside, "secret.txt"), join(root, "docs", "escape.md"));
    local = await service(root, join(home, "data-ts"));
    native = await service(root, join(home, "data-rust"), { workspaceIo: aceFilesIo(tool) });
  });

  afterAll(async () => {
    await local?.close();
    await native?.close();
    await tool.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("stats a file, a folder and a missing path exactly as the TypeScript path did", async () => {
    expect(value(await both({ op: "stat", path: "notes.md" }))).toMatchObject(recorded.statFile);
    expect(value(await both({ op: "stat", path: "docs" }))).toMatchObject(recorded.statFolder);
    expect(value(await both({ op: "stat", path: "gone.md" }))).toEqual(recorded.statMissing);
  });

  it("reads one part of a file, a folder and a missing path exactly as before", async () => {
    expect(value(await both({ op: "read", path: "notes.md" }))).toEqual(recorded.readPart);
    expect(value(await both({ op: "read", path: "docs" }))).toEqual(recorded.readFolder);
    expect(value(await both({ op: "read", path: "gone.md" }))).toEqual(recorded.readMissing);
  });

  it("pages a read, compresses a large part, and reports no bytes past maxSize", async () => {
    const part = value(await both({ op: "read", path: "notes.md", offset: 7, length: 5 }));
    expect(part).toMatchObject({ offset: 7, encoding: "identity" });
    expect(Buffer.from(String(part.data), "base64").toString()).toBe("world");

    const compressed = value(await both({ op: "read", path: "large.bin", encodings: ["gzip"] }));
    expect(compressed).toMatchObject({ encoding: "gzip", size: 4096 });

    const limited = value(await both({ op: "read", path: "large.bin", maxSize: 1024 }));
    expect(limited).toEqual({ path: "large.bin", version: versioned, type: "file", size: 4096 });
  });

  it("describes an inside link by its target and reports a dangling one as absent", async () => {
    const inside = join(root, "docs", "inside.md");
    const dangling = join(root, "docs", "dangling.md");
    await symlink("guide.md", inside);
    await symlink("nothing.md", dangling);
    try {
      const link = value(await both({ op: "stat", path: "docs/inside.md" }));
      expect(link).toMatchObject({ type: "symlink", size: 6, version: versioned });
      expect(link.version).toBe(
        String(value(await ask(local, { op: "stat", path: "docs/guide.md" })).version),
      );
      expect(value(await both({ op: "read", path: "docs/inside.md" }))).toMatchObject({
        type: "symlink",
        size: 6,
      });
      for (const path of ["docs/dangling.md", "docs/gone.md"]) {
        expect(value(await both({ op: "stat", path }))).toEqual({ path, version: null });
        expect(value(await both({ op: "read", path }))).toEqual({ path, version: null });
      }
    } finally {
      await rm(inside);
      await rm(dangling);
    }
  });

  it("reports a path under a file as the same failure on both paths", async () => {
    for (const operation of [
      { op: "stat", path: "notes.md/under" },
      { op: "read", path: "notes.md/under" },
    ]) {
      expect(await both(operation)).toMatchObject({ ok: false, code: "NOT_DIRECTORY" });
    }
  });

  it("answers a stale read validator with the current version", async () => {
    const stale = failure(await both({ op: "read", path: "notes.md", validator: "1:2:3:4:5" }));
    expect(stale.code).toBe("CONFLICT");
    expect(stale.current).toBe(await version("notes.md"));
  });

  it("downloads a file in the same chunks with the same validator", async () => {
    const [byTs, byRust] = await Promise.all([
      local.download("owner", { op: "download", path: "large.bin", offset: 0 }),
      native.download("owner", { op: "download", path: "large.bin", offset: 0 }),
    ]);
    expect(byRust.validator).toBe(byTs.validator);
    expect(byRust.size).toBe(byTs.size);
    const [bytesTs, bytesRust] = await Promise.all([drain(byTs), drain(byRust)]);
    expect(bytesRust.equals(bytesTs)).toBe(true);
    expect(bytesRust.length).toBe(4096);
  });

  it("refuses a resumed download whose validator moved", async () => {
    const stale = failure(
      await bothDownloads({ op: "download", path: "notes.md", offset: 4, validator: "1:2:3:4:5" }),
    );
    expect(stale.code).toBe("CONFLICT");
    expect(stale).toMatchObject({ current: versioned });
  });

  it("creates and writes with the reply the TypeScript path gives", async () => {
    expect(
      value(await ask(local, { op: "create", path: "fresh.md", expected: null, text: "one\n" })),
    ).toMatchObject(recorded.created);
    expect(
      value(await ask(native, { op: "create", path: "native.md", expected: null, text: "one\n" })),
    ).toMatchObject({ ...recorded.created, path: "native.md" });
    expect(await readFile(join(root, "fresh.md"), "utf8")).toBe("one\n");
    expect(await readFile(join(root, "native.md"), "utf8")).toBe("one\n");

    for (const [target, path] of [
      [local, "fresh.md"],
      [native, "native.md"],
    ] as const) {
      const written = value(
        await ask(target, { op: "write", path, expected: await version(path), text: "two\n" }),
      );
      expect(written).toEqual({ id: expect.any(String), op: "write", path, version: versioned });
      expect(await readFile(join(root, path), "utf8")).toBe("two\n");
    }
  });

  it("makes folders, and refuses a taken name on both paths alike", async () => {
    expect(value(await ask(local, { op: "mkdir", path: "made", expected: null }))).toMatchObject(
      recorded.folder,
    );
    expect(
      value(await ask(native, { op: "mkdir", path: "made-native", expected: null })),
    ).toMatchObject({ ...recorded.folder, path: "made-native" });
    // The client already knows the name is taken; the version it collided with is the folder's.
    const taken = failure(await both({ op: "mkdir", path: "made", expected: null }));
    expect(taken).toMatchObject({ code: "CONFLICT", current: versioned });
  });

  it("rejects a stale write with the current version", async () => {
    const stale = await version("notes.md");
    await writeFile(join(root, "notes.md"), "outside\n");
    try {
      const refused = failure(
        await both({ op: "write", path: "notes.md", expected: stale, text: "ours\n" }),
      );
      expect(refused.code).toBe("CONFLICT");
      expect(refused).toMatchObject({ current: versioned });
      expect(refused.current).not.toBe(stale);
      expect(await readFile(join(root, "notes.md"), "utf8")).toBe("outside\n");
    } finally {
      await writeFile(join(root, "notes.md"), "hello, world\n");
    }
  });

  it("renames and moves without replacing a taken destination", async () => {
    const moved = value(
      await ask(native, {
        op: "rename",
        path: "native.md",
        expected: await version("native.md"),
        destination: "moved.md",
        destinationExpected: null,
      }),
    );
    expect(moved).toEqual({
      id: expect.any(String),
      op: "rename",
      path: "native.md",
      destination: "moved.md",
      version: versioned,
    });
    expect(await readFile(join(root, "moved.md"), "utf8")).toBe("two\n");

    const taken = failure(
      await both({
        op: "move",
        path: "moved.md",
        expected: await version("moved.md"),
        destination: "notes.md",
        destinationExpected: await version("notes.md"),
      }),
    );
    expect(taken.code).toBe("CONFLICT");
    expect(taken).toMatchObject({ current: versioned });
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("hello, world\n");
  });

  it("deletes into recently-deleted and restores the exact bytes", async () => {
    for (const [target, path] of [
      [local, "trash-local.md"],
      [native, "trash-rust.md"],
    ] as const) {
      await writeFile(join(root, path), "keep me\n");
      const expected = await version(path);
      const deleted = value(await ask(target, { op: "delete", path, expected }));
      expect(deleted).toMatchObject({
        op: "delete",
        path,
        version: null,
        trashId: expect.any(String),
      });
      await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });

      const trash = (await target.request("owner", { op: "trash.list" })) as {
        entries: { id: string; path: string; size: number; version: string }[];
      };
      expect(trash.entries).toContainEqual({
        id: String(deleted.trashId),
        path,
        size: 8,
        version: expected,
        expires: expect.any(Number),
      });

      const restored = (await target.request("owner", {
        op: "restore",
        trashId: String(deleted.trashId),
        path,
        expected: null,
      })) as { version: string };
      expect(restored).toMatchObject({ version: versioned });
      expect(await readFile(join(root, path), "utf8")).toBe("keep me\n");
    }
  });

  it("refuses a delete whose expectation moved, with the version on disk", async () => {
    const stale = await version("trash-rust.md");
    await writeFile(join(root, "trash-rust.md"), "changed\n");
    try {
      const refused = failure(await both({ op: "delete", path: "trash-rust.md", expected: stale }));
      expect(refused.code).toBe("CONFLICT");
      expect(refused).toMatchObject({ current: versioned });
    } finally {
      await writeFile(join(root, "trash-rust.md"), "keep me\n");
    }
  });

  it("refuses every operation that follows a link out of the checkout", async () => {
    for (const operation of [
      { op: "stat", path: "escape" },
      { op: "read", path: "escape" },
    ]) {
      expect(failure(await both(operation))).toMatchObject({ code: "PATH_ESCAPE" });
    }
    expect(
      failure(await bothDownloads({ op: "download", path: "escape", offset: 0 })),
    ).toMatchObject({ code: "PATH_ESCAPE" });
    expect(
      failure(await both({ op: "write", path: "escape", expected: null, text: "x" })),
    ).toMatchObject({ code: "PATH_ESCAPE" });
    expect(await readFile(join(home, "outside", "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("streams a 50 MB download without holding it", async () => {
    const big = join(root, "big.bin");
    const block = Buffer.alloc(1024 * 1024, 3);
    const handle = await open(big, "w");
    try {
      for (let part = 0; part < 50; part++) await handle.write(block);
    } finally {
      await handle.close();
    }
    const before = collected();
    const opened = await native.download("owner", { op: "download", path: "big.bin", offset: 0 });
    expect(opened.size).toBe(50 * 1024 * 1024);
    let read = 0;
    let largest = 0;
    let mid = before;
    for await (const part of opened.chunks) {
      read += part.length;
      largest = Math.max(largest, part.length);
      if (read === 25 * 1024 * 1024) mid = collected();
    }
    expect(read).toBe(50 * 1024 * 1024);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(mid - before).toBeLessThan(16 * 1024 * 1024);
    expect(collected() - before).toBeLessThan(16 * 1024 * 1024);
  }, 30_000);

  it("deletes a folder into recently-deleted with the same reserved bytes", async () => {
    for (const name of ["gone-ts", "gone-rust"]) {
      await mkdir(join(root, name, ".git"), { recursive: true });
      await mkdir(join(root, name, "nested"));
      await writeFile(join(root, name, "a.md"), "aaaa");
      await writeFile(join(root, name, ".git", "objects"), "git");
      await writeFile(join(root, name, "nested", "b.md"), "bb");
    }
    for (const [target, path] of [
      [local, "gone-ts"],
      [native, "gone-rust"],
    ] as const) {
      const deleted = value(
        await ask(target, { op: "delete", path, expected: await version(path) }),
      );
      expect(deleted).toMatchObject({
        op: "delete",
        path,
        version: null,
        trashId: expect.any(String),
      });
      const trash = (await target.request("owner", { op: "trash.list" })) as {
        entries: { id: string; path: string; size: number }[];
      };
      expect(trash.entries).toContainEqual({
        id: String(deleted.trashId),
        path,
        size: 9,
        version: expect.any(String),
        expires: expect.any(Number),
      });
      await target.request("owner", {
        op: "restore",
        trashId: String(deleted.trashId),
        path,
        expected: null,
      });
      expect(await readFile(join(root, path, "nested", "b.md"), "utf8")).toBe("bb");
    }
  });

  it("previews and downloads a folder archive with the same members", async () => {
    for (const path of ["docs", ""]) {
      const byTs = await preview(local, path);
      const byRust = await preview(native, path);
      expect(byRust).toMatchObject({
        bytes: byTs.bytes,
        entries: byTs.entries,
        format: byTs.format,
      });
      // Ignored files stay out, an inside link counts as its target, and an escaping one is
      // neither followed nor listed.
      const members = await archiveMembers(native, byRust.previewId);
      expect(members).toEqual(await archiveMembers(local, byTs.previewId));
      if (path === "docs") {
        expect([...members.keys()].toSorted()).toEqual([
          ".gitignore",
          "guide.md",
          "nested",
          "nested/deep.md",
        ]);
      }
    }
  }, 30_000);

  it("fails retryably when this machine has no ace-files", async () => {
    const missing = await service(root, join(home, "data-missing"), {
      workspaceIo: aceFilesIo(new FilesTool({ binary: undefined })),
    });
    try {
      for (const operation of [
        { op: "stat", path: "notes.md" },
        { op: "read", path: "notes.md" },
        { op: "write", path: "notes.md", expected: null, text: "x" },
      ]) {
        await expect(missing.request("owner", operation)).rejects.toMatchObject({
          code: "FILES_RESTARTING",
        });
      }
      await expect(
        missing.download("owner", { op: "download", path: "notes.md", offset: 0 }),
      ).rejects.toMatchObject({ code: "FILES_RESTARTING" });
    } finally {
      await missing.close();
    }
  });
});
