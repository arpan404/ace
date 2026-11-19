import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import type { FileOperation } from "@ace/protocol";
import { encodeFileFrame } from "./index.ts";
import { fixture, type Client } from "./test-support.ts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { SafeRoot } from "@ace/workspace";
import { createExclusiveRename } from "./exclusive-rename.ts";
import { localFilesIo } from "./local-io.ts";
import { FileError } from "./types.ts";
import type { FilesIo } from "./io.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { decodeFileFrame } from "./index.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanup.push(() => f.close());
  return f;
}
async function version(client: Client, path: string): Promise<string | null> {
  const response = await client.request({ op: "stat", path });
  return z
    .object({
      type: z.literal("files.result"),
      value: z.object({ version: z.string().nullable() }),
    })
    .parse(response).value.version;
}
const Result = z.object({
  type: z.literal("files.result"),
  value: z.object({ trashId: z.string() }),
});
const Upload = z.object({
  type: z.literal("files.upload"),
  channel: z.number(),
  uploadId: z.string(),
});

it("rejects an agent edit conflict and broadcasts successful mutations to another device", async () => {
  const f = await setup();
  const client = await f.connect();
  const observer = await f.connect();
  await writeFile(join(f.root, "file"), "original");
  const before = await version(client, "file");
  await writeFile(join(f.root, "file"), "agent");
  expect(
    await client.request({ op: "write", path: "file", expected: before, text: "human" }),
  ).toMatchObject({ type: "files.error", code: "CONFLICT" });
  expect(await readFile(join(f.root, "file"), "utf8")).toBe("agent");
  const current = await version(client, "file");
  expect(
    await client.request({ op: "write", path: "file", expected: current, text: "human" }),
  ).toMatchObject({ type: "files.result" });
  // Observer's stat reply follows the broadcast on the same socket.
  await version(observer, "file");
  expect(observer.changes).toContainEqual(
    expect.objectContaining({ change: expect.objectContaining({ path: "file", op: "write" }) }),
  );
  expect(await readFile(join(f.root, "file"), "utf8")).toBe("human");
});

it("creates, renames and moves without silently replacing existing destinations", async () => {
  const f = await setup();
  const client = await f.connect();
  expect(await client.request({ op: "mkdir", path: "dir", expected: null })).toMatchObject({
    type: "files.result",
  });
  expect(
    await client.request({ op: "create", path: "a", expected: null, text: "hello" }),
  ).toMatchObject({ type: "files.result" });
  const initial = await version(client, "a");
  expect(
    await client.request({
      op: "rename",
      path: "a",
      expected: initial,
      destination: "b",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "b"), "utf8")).toBe("hello");
  expect(
    await client.request({
      op: "move",
      path: "b",
      expected: await version(client, "b"),
      destination: "dir/b",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "dir/b"), "utf8")).toBe("hello");
  await writeFile(join(f.root, "existing"), "keep");
  expect(
    await client.request({
      op: "rename",
      path: "dir/b",
      expected: await version(client, "dir/b"),
      destination: "existing",
      destinationExpected: null,
    }),
  ).toMatchObject({ code: "CONFLICT" });
  expect(await readFile(join(f.root, "existing"), "utf8")).toBe("keep");
  expect(
    await client.request({ op: "create", path: "existing", expected: null, text: "clobber" }),
  ).toMatchObject({ code: "CONFLICT" });
});

it("deletes into durable trash then restores exact bytes after restart", async () => {
  const f = await setup();
  const client = await f.connect();
  const bytes = Buffer.from([0, 1, 255, 99]);
  await writeFile(join(f.root, "binary"), bytes);
  const deleted = Result.parse(
    await client.request({
      op: "delete",
      path: "binary",
      expected: await version(client, "binary"),
    }),
  );
  await expect(readFile(join(f.root, "binary"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.restart();
  const next = await f.connect();
  expect(
    await next.request({
      op: "restore",
      path: "restored",
      trashId: deleted.value.trashId,
      expected: null,
    }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "restored"))).toEqual(bytes);
});

it("trash retention and quota never discard a live workspace file", async () => {
  let now = 100;
  const f = await setup({ now: () => now, retentionMs: 10, maxTrashBytes: 3 });
  const client = await f.connect();
  await writeFile(join(f.root, "large"), "four");
  expect(
    await client.request({ op: "delete", path: "large", expected: await version(client, "large") }),
  ).toMatchObject({ code: "QUOTA" });
  expect(await readFile(join(f.root, "large"), "utf8")).toBe("four");
  await writeFile(join(f.root, "small"), "abc");
  const deleted = Result.parse(
    await client.request({ op: "delete", path: "small", expected: await version(client, "small") }),
  );
  now += 11;
  await f.service.sweep();
  expect(
    await client.request({
      op: "restore",
      path: "small",
      trashId: deleted.value.trashId,
      expected: null,
    }),
  ).toMatchObject({ code: "NOT_FOUND" });
  expect(await readdir(join(f.home, "data", "trash"))).toEqual([]);
});

it("rejects path escapes for every operation with a workspace endpoint", async () => {
  const f = await setup();
  const client = await f.connect();
  await writeFile(join(f.root, "source"), "source");
  await writeFile(join(f.home, "outside"), "untouched");
  const operations: FileOperation[] = [
    { op: "stat", path: "../outside" },
    { op: "download", path: "../outside", offset: 0 },
    { op: "archive.preview", path: "../", includeIgnored: false },
    { op: "upload.begin", path: "../outside", expected: null, size: 1 },
    { op: "write", path: "../outside", expected: null, text: "bad" },
    { op: "create", path: "../outside", expected: null, text: "bad" },
    { op: "mkdir", path: "../dir", expected: null },
    { op: "delete", path: "../outside", expected: null },
    { op: "restore", path: "../outside", expected: null, trashId: "none" },
  ];
  for (const op of ["rename", "move"] as const) {
    operations.push({
      op,
      path: "../outside",
      expected: null,
      destination: "inside",
      destinationExpected: null,
    });
    operations.push({
      op,
      path: "source",
      expected: await version(client, "source"),
      destination: "../outside",
      destinationExpected: null,
    });
  }
  for (const operation of operations)
    expect(await client.request(operation)).toMatchObject({
      type: "files.error",
      code: "INVALID_PATH",
    });
  for (const path of ["/etc/passwd", "C:/outside", "a\\outside", "a/../../outside", "\0outside"])
    expect(await client.request({ op: "download", path, offset: 0 })).toMatchObject({
      code: "INVALID_PATH",
    });
  expect(await readFile(join(f.home, "outside"), "utf8")).toBe("untouched");
  expect(await readFile(join(f.root, "source"), "utf8")).toBe("source");
});

it("rejects symlink parents on resumed upload and every mutation", async () => {
  const f = await setup();
  const client = await f.connect();
  await mkdir(join(f.root, "dir"));
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path: "dir/a", expected: null, size: 1 }),
  );
  await rm(join(f.root, "dir"), { recursive: true });
  await symlink(f.home, join(f.root, "dir"));
  expect(await client.request({ op: "upload.resume", uploadId: upload.uploadId })).toMatchObject({
    code: "PATH_ESCAPE",
  });
  client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("a")));
  expect(await client.next()).toMatchObject({ code: "PATH_ESCAPE" });
  expect(
    await client.request({
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: createHash("sha256").update("a").digest("hex"),
    }),
  ).toMatchObject({ code: "PATH_ESCAPE" });
  const operations: FileOperation[] = [
    { op: "write", path: "dir/other", expected: null, text: "bad" },
    { op: "create", path: "dir/other", expected: null, text: "bad" },
    { op: "mkdir", path: "dir/other", expected: null },
    {
      op: "rename",
      path: "dir/other",
      expected: null,
      destination: "other",
      destinationExpected: null,
    },
    {
      op: "move",
      path: "dir/other",
      expected: null,
      destination: "other",
      destinationExpected: null,
    },
    { op: "delete", path: "dir/other", expected: null },
    { op: "restore", path: "dir/other", expected: null, trashId: "none" },
    { op: "upload.begin", path: "dir/other", expected: null, size: 1 },
  ];
  for (const operation of operations)
    expect(await client.request(operation)).toMatchObject({ code: "PATH_ESCAPE" });
  await expect(readFile(join(f.home, "a"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("allows a read-only device to download while denying all mutation operations and upload frames", async () => {
  const f = await setup();
  await writeFile(join(f.root, "a"), "a");
  const client = await f.connect(true);
  expect(await client.request({ op: "download", path: "a", offset: 0 })).toMatchObject({
    type: "files.ready",
  });
  const operations: FileOperation[] = [
    { op: "write", path: "a", expected: null, text: "bad" },
    { op: "create", path: "b", expected: null, text: "bad" },
    { op: "mkdir", path: "b", expected: null },
    { op: "rename", path: "a", expected: null, destination: "b", destinationExpected: null },
    { op: "move", path: "a", expected: null, destination: "b", destinationExpected: null },
    { op: "delete", path: "a", expected: null },
    { op: "restore", path: "a", expected: null, trashId: "none" },
    { op: "upload.begin", path: "b", expected: null, size: 1 },
    { op: "upload.resume", uploadId: "none" },
    { op: "upload.commit", uploadId: "none", sha256: "0".repeat(64) },
    { op: "upload.cancel", uploadId: "none" },
  ];
  for (const operation of operations)
    expect(await client.request(operation)).toMatchObject({ code: "FORBIDDEN" });
  client.socket.send(encodeFileFrame(1, 0, Buffer.from("a")));
  expect(await client.next()).toMatchObject({ code: "FORBIDDEN" });
  expect(await readFile(join(f.root, "a"), "utf8")).toBe("a");
});
it("preserves executable permissions when replacing a file through edits or uploads", async () => {
  const f = await setup();
  const client = await f.connect();
  const file = join(f.root, "script");
  await writeFile(file, "old");
  await chmod(file, 0o755);
  expect(
    await client.request({
      op: "write",
      path: "script",
      expected: await version(client, "script"),
      text: "edited",
    }),
  ).toMatchObject({ type: "files.result" });
  expect((await stat(file)).mode & 0o777).toBe(0o755);
  const upload = Upload.parse(
    await client.request({
      op: "upload.begin",
      path: "script",
      expected: await version(client, "script"),
      size: 3,
    }),
  );
  client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("new")));
  await client.next();
  expect(
    await client.request({
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: createHash("sha256").update("new").digest("hex"),
    }),
  ).toMatchObject({ type: "files.result" });
  expect((await stat(file)).mode & 0o777).toBe(0o755);
  expect(await readFile(file, "utf8")).toBe("new");
});

const windows = process.platform === "win32";
const run = promisify(execFile);
async function windowsUpload(client: Client, path: string, expected: string | null, text: string) {
  const bytes = Buffer.from(text);
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path, expected, size: bytes.length }),
  );
  client.socket.send(encodeFileFrame(upload.channel, 0, bytes));
  await client.next();
  return client.request({
    op: "upload.commit",
    uploadId: upload.uploadId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
async function windowsDownload(client: Client, path: string): Promise<string> {
  const ready = z
    .object({ type: z.literal("files.ready"), channel: z.number() })
    .parse(await client.request({ op: "download", path, offset: 0 }));
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  const frame = decodeFileFrame(z.instanceof(Buffer).parse(await client.next()));
  expect(await client.next()).toMatchObject({ type: "files.end" });
  return frame.bytes.toString("utf8");
}

it.runIf(windows)(
  "Windows: keeps a read-only file read-only when replacing it through edits or uploads",
  async () => {
    const f = await setup();
    const client = await f.connect();
    const file = join(f.root, "locked.txt");
    await writeFile(file, "old");
    await chmod(file, 0o444);
    expect(
      await client.request({
        op: "write",
        path: "locked.txt",
        expected: await version(client, "locked.txt"),
        text: "edited",
      }),
    ).toMatchObject({ type: "files.result" });
    expect(await readFile(file, "utf8")).toBe("edited");
    expect((await stat(file)).mode & 0o200).toBe(0);
    expect(
      await windowsUpload(client, "locked.txt", await version(client, "locked.txt"), "uploaded"),
    ).toMatchObject({ type: "files.result" });
    expect(await readFile(file, "utf8")).toBe("uploaded");
    expect((await stat(file)).mode & 0o200).toBe(0);
    // A writable file stays writable.
    await writeFile(join(f.root, "open.txt"), "old");
    expect(
      await client.request({
        op: "write",
        path: "open.txt",
        expected: await version(client, "open.txt"),
        text: "new",
      }),
    ).toMatchObject({ type: "files.result" });
    expect((await stat(join(f.root, "open.txt"))).mode & 0o200).toBe(0o200);
    await chmod(file, 0o666);
  },
);

it.runIf(windows)(
  "Windows: an edit waits out another program briefly holding the file without delete sharing",
  async () => {
    const f = await setup();
    const client = await f.connect();
    const file = join(f.root, "held.txt");
    await writeFile(file, "old");
    const expected = await version(client, "held.txt");
    const holder = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$f=[IO.File]::Open($env:ACE_HELD,'Open','Read','Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 300; $f.Close()",
      ],
      { env: { ...process.env, ACE_HELD: file }, stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(holder, "exit");
    await once(holder.stdout, "data");
    expect(
      await client.request({ op: "write", path: "held.txt", expected, text: "edited" }),
    ).toMatchObject({ type: "files.result" });
    await exited;
    expect(await readFile(file, "utf8")).toBe("edited");
  },
);

it.runIf(windows)(
  "Windows: refuses names that differ only in case from an existing file, and reserved names",
  async () => {
    const f = await setup();
    const client = await f.connect();
    await writeFile(join(f.root, "Foo.txt"), "mine");
    expect(
      await client.request({ op: "create", path: "foo.txt", expected: null, text: "other" }),
    ).toMatchObject({ type: "files.error", code: "CONFLICT" });
    expect(
      await client.request({ op: "upload.begin", path: "FOO.TXT", expected: null, size: 1 }),
    ).toMatchObject({ type: "files.error", code: "CONFLICT" });
    expect(await readdir(f.root)).toEqual(["Foo.txt"]);
    expect(await readFile(join(f.root, "Foo.txt"), "utf8")).toBe("mine");
    for (const path of ["CON", "nul.txt", "com1", "trailing.", "trailing ", "a:b", "x?y"])
      expect(await client.request({ op: "create", path, expected: null, text: "x" })).toMatchObject(
        { type: "files.error", code: "INVALID_PATH" },
      );
    expect(await readdir(f.root)).toEqual(["Foo.txt"]);
  },
);

it.runIf(windows)(
  "Windows: uploads, downloads, edits, trashes and restores Unicode names past MAX_PATH",
  async () => {
    const f = await setup();
    const client = await f.connect();
    const folder = Array.from(
      { length: 5 },
      (_, index) => `${"深".repeat(20)}-${"d".repeat(40)}-${index}`,
    ).join("/");
    await mkdir(join(f.root, ...folder.split("/")), { recursive: true });
    const path = `${folder}/界 ünïcode.txt`;
    expect(join(f.root, ...path.split("/")).length).toBeGreaterThan(300);
    expect(await windowsUpload(client, path, null, "first")).toMatchObject({
      type: "files.result",
    });
    expect(await windowsDownload(client, path)).toBe("first");
    expect(
      await client.request({
        op: "write",
        path,
        expected: await version(client, path),
        text: "second",
      }),
    ).toMatchObject({ type: "files.result" });
    expect(await readFile(join(f.root, ...path.split("/")), "utf8")).toBe("second");
    const deleted = Result.parse(
      await client.request({ op: "delete", path, expected: await version(client, path) }),
    );
    expect(await version(client, path)).toBeNull();
    expect(
      await client.request({ op: "restore", path, expected: null, trashId: deleted.value.trashId }),
    ).toMatchObject({ type: "files.result" });
    expect(await windowsDownload(client, path)).toBe("second");
  },
);

it.runIf(windows)("Windows renames a file to a case-only variant of its own name", async () => {
  const f = await setup();
  const client = await f.connect();
  await writeFile(join(f.root, "Foo.txt"), "mine");
  expect(
    await client.request({
      op: "rename",
      path: "Foo.txt",
      expected: await version(client, "Foo.txt"),
      destination: "foo.txt",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result", value: { destination: "foo.txt" } });
  expect(await readdir(f.root)).toEqual(["foo.txt"]);
  expect(await readFile(join(f.root, "foo.txt"), "utf8")).toBe("mine");
  // A different file under the other case still conflicts; a case-sensitive folder holds both.
  const folder = join(f.root, "sensitive");
  await mkdir(folder);
  await run("fsutil.exe", ["file", "setCaseSensitiveInfo", folder, "enable"]);
  await writeFile(join(folder, "Bar.txt"), "one");
  await writeFile(join(folder, "bar.txt"), "two");
  expect(
    await client.request({
      op: "rename",
      path: "sensitive/Bar.txt",
      expected: await version(client, "sensitive/Bar.txt"),
      destination: "sensitive/bar.txt",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.error", code: "CONFLICT" });
  expect((await readdir(folder)).toSorted()).toEqual(["Bar.txt", "bar.txt"]);
  expect(await readFile(join(folder, "Bar.txt"), "utf8")).toBe("one");
  expect(await readFile(join(folder, "bar.txt"), "utf8")).toBe("two");
});

/**
 * A port that changes a path once, exactly when the queued mutation reaches its guarded step.
 *
 * The policy and the guard live in the mutation op now, so a race is injected on the op itself:
 * the fake does the outside write and then hands the call on, as a program that wins the race
 * between preparation and the queued step would.
 */
function racingIo(interject: (path: string) => Promise<void>) {
  const base = localFilesIo((root) => SafeRoot.create(root));
  const racing = {
    armed: false,
    target: "",
  };
  const race = async (path: string) => {
    if (!racing.armed || path !== racing.target) return;
    racing.armed = false;
    await interject(path);
  };
  return {
    racing,
    io: {
      ...base,
      async write(
        root: string,
        path: string,
        bytes: Buffer,
        expected: string | null,
      ): Promise<string> {
        await race(path);
        return base.write(root, path, bytes, expected);
      },
      async trash(
        root: string,
        path: string,
        endpoint: string,
        expected: string,
        own: string | null,
      ): Promise<void> {
        await race(path);
        return base.trash(root, path, endpoint, expected, own);
      },
    } satisfies typeof base,
  };
}

it("reports the version on disk when a change lands between prepare and apply", async () => {
  const { io, racing } = racingIo(() => writeFile(join(f.root, "file"), "outside save"));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();
  await writeFile(join(f.root, "file"), "original");
  const before = await version(client, "file");
  racing.target = "file";
  racing.armed = true;
  const reply = await client.request({ op: "write", path: "file", expected: before, text: "ours" });
  const current = await version(client, "file");
  expect(reply).toMatchObject({ type: "files.error", code: "CONFLICT", current });
  expect(current).not.toBe(before);
  expect(await readFile(join(f.root, "file"), "utf8")).toBe("outside save");
});

it("refuses a folder whose tree changed when the delete reaches the queue", async () => {
  const { io, racing } = racingIo(async () => {
    await writeFile(join(f.root, "dir", "arrived"), "new");
  });
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "dir", "a"), "a");
  const before = await version(client, "dir");
  racing.target = "dir";
  racing.armed = true;
  const reply = await client.request({ op: "delete", path: "dir", expected: before });
  const current = await version(client, "dir");
  expect(reply).toMatchObject({ type: "files.error", code: "CONFLICT", current });
  expect(current).not.toBe(before);
  expect(await readdir(join(f.root, "dir"))).toEqual(["a", "arrived"]);
});

it("rejects a folder's own version as a destructive guard", async () => {
  const f = await setup();
  const client = await f.connect();
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "dir", "a"), "a");
  const direct = localFilesIo((root) => SafeRoot.create(root));
  const shallow = await direct.shallow(f.root, "dir");
  expect(shallow?.version.startsWith("tree:") ?? false).toBe(false);

  const refused = await client.request({
    op: "delete",
    path: "dir",
    expected: shallow?.version ?? null,
  });

  expect(refused).toMatchObject({ type: "files.error", code: "INVALID_ARGUMENT" });
  expect(await readFile(join(f.root, "dir", "a"), "utf8")).toBe("a");
});

it("restores a pre-cutover trash entry only onto an absent, link-free destination", async () => {
  const real = createExclusiveRename();
  cleanup.push(() => real.close());
  let squat = true;
  const f = await setup({
    exclusiveRename: {
      async move(source, destination) {
        // A file that appears after the queue admitted the restore is never replaced.
        if (squat && source.includes("/trash/")) await writeFile(destination, "squatter");
        squat = false;
        await real.move(source, destination);
      },
      close: async () => {},
    },
  });
  const id = "legacy-entry";
  const bytes = Buffer.from("legacy\n");
  await mkdir(join(f.home, "data", "trash"), { recursive: true });
  await writeFile(join(f.home, "data", "trash", id), bytes);
  const database = new DatabaseSync(join(f.home, "data", "files.sqlite"));
  try {
    database.prepare("INSERT INTO resources VALUES(?,?,?,?,?)").run(
      id,
      "trash",
      Date.now() + 60_000,
      bytes.length,
      JSON.stringify({
        kind: "trash",
        id,
        path: "legacy.md",
        bytes: bytes.length,
        version: "1:2:7:3:4",
        expires: Date.now() + 60_000,
      }),
    );
  } finally {
    database.close();
  }

  const client = await f.connect();
  // A link at the destination is the destination's own business, and never a restore target.
  await symlink("elsewhere", join(f.root, "linked.md"));
  expect(
    await client.request({ op: "restore", trashId: id, path: "linked.md", expected: null }),
  ).toMatchObject({ type: "files.error", code: "PATH_ESCAPE" });

  const refused = await client.request({
    op: "restore",
    trashId: id,
    path: "legacy.md",
    expected: null,
  });
  expect(refused).toMatchObject({ type: "files.error", code: "CONFLICT" });
  const squatter = await version(client, "legacy.md");
  expect(refused).toMatchObject({ current: squatter });
  expect(await readFile(join(f.root, "legacy.md"), "utf8")).toBe("squatter");
  expect(await client.request({ op: "trash.list", limit: 32 })).toMatchObject({
    value: { entries: [expect.objectContaining({ id, path: "legacy.md" })] },
  });

  await rm(join(f.root, "legacy.md"));
  expect(
    await client.request({ op: "restore", trashId: id, path: "legacy.md", expected: null }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "legacy.md"), "utf8")).toBe("legacy\n");
});

/** The local port with one step replaced, so a test can fail an answer at an exact moment. */
async function port(replace: (base: FilesIo) => Partial<FilesIo>): Promise<FilesIo> {
  const base = localFilesIo((root) => SafeRoot.create(root));
  return { ...base, ...replace(base) };
}

it("keeps a delete restorable when its answer is lost after the entry moved", async () => {
  let now = 100;
  let down = true;
  const io = await port((base) => ({
    async trash(root, path, endpoint, expected, own) {
      await base.trash(root, path, endpoint, expected, own);
      // The move landed; the answer never came back.
      throw new FileError("FILES_RESTARTING", "the process went away before it answered");
    },
    internal: {
      ...base.internal,
      // Not even the daemon's own probe can reach the checkout while the process is down, so
      // nothing can prove where the entry went and the receipt stays pending.
      async describe(root, path) {
        if (down) throw new FileError("FILES_RESTARTING", "the process is still down");
        return base.internal.describe(root, path);
      },
    },
    async shallow() {
      if (down) throw new FileError("FILES_RESTARTING", "the process is still down");
      return null;
    },
  }));
  const f = await setup({ workspaceIo: io, now: () => now, retentionMs: 10 });
  const client = await f.connect();
  await writeFile(join(f.root, "report.md"), "quarterly\n");

  expect(
    await client.request({
      op: "delete",
      path: "report.md",
      expected: await version(client, "report.md"),
    }),
  ).toMatchObject({ type: "files.error", code: "FILES_RESTARTING" });
  await expect(readFile(join(f.root, "report.md"))).rejects.toMatchObject({ code: "ENOENT" });

  // The receipt names the entry, so it is restorable even though the delete reported a failure.
  const listed = z
    .object({ value: z.object({ entries: z.array(z.object({ id: z.string() })) }) })
    .parse(await client.request({ op: "trash.list", limit: 32 }));
  const [entry, ...rest] = listed.value.entries;
  expect(rest).toEqual([]);
  if (!entry) throw new Error("the lost answer left no restorable entry");

  // While the receipt is unresolved it never expires, however long the daemon runs.
  now += 10_000;
  await f.service.sweep();
  expect(await client.request({ op: "trash.list", limit: 32 })).toMatchObject({
    value: { entries: [expect.objectContaining({ id: entry.id })] },
  });

  // A start reconciles it: the entry is not at its path, so it is an ordinary trash entry again.
  down = false;
  await f.restart();
  const next = await f.connect();
  expect(
    await next.request({
      op: "restore",
      path: "report.md",
      trashId: entry.id,
      expected: null,
    }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "report.md"), "utf8")).toBe("quarterly\n");
});

it("keeps a pending delete receipt whose trash endpoint holds another entry", async () => {
  let now = 100;
  const f = await setup({ now: () => now, retentionMs: 10 });
  const id = "pending-foreign";
  const location = `.ace-upload-trash-${id}`;
  const bytes = Buffer.from("an entry this receipt never moved\n");
  await writeFile(join(f.root, location), bytes);
  // A receipt from a delete interrupted before its answer: the path is gone, but the endpoint
  // holds a different entry, so nothing proves this delete's move landed.
  const database = new DatabaseSync(join(f.home, "data", "files.sqlite"));
  try {
    database.prepare("INSERT INTO resources VALUES(?,?,?,?,?)").run(
      id,
      "trash",
      Number.MAX_SAFE_INTEGER,
      bytes.length,
      JSON.stringify({
        kind: "trash",
        id,
        path: "report.md",
        bytes: bytes.length,
        version: "1:2:3:4:5",
        identity: "1:999:5:6:7",
        location,
        expires: Number.MAX_SAFE_INTEGER,
        pending: true,
      }),
    );
  } finally {
    database.close();
  }

  await f.restart();
  // Past the retention window: a pending receipt is exempt, and a settled one would have swept
  // the endpoint, destroying an entry this receipt never owned.
  await new Promise((resolve) => setTimeout(resolve, 25));
  now += 10_000;
  await f.service.sweep();

  expect(await readFile(join(f.root, location), "utf8")).toBe(bytes.toString());
  const listed = z
    .object({
      value: z.object({ entries: z.array(z.object({ id: z.string(), expires: z.number() })) }),
    })
    .parse(await (await f.connect()).request({ op: "trash.list", limit: 32 }));
  expect(listed.value.entries).toEqual([
    expect.objectContaining({ id, expires: Number.MAX_SAFE_INTEGER }),
  ]);
});

it("reports a failed trash rollback as its own outcome and keeps its receipt pending", async () => {
  let now = 100;
  let down = true;
  let location = "";
  const io = await port((base) => ({
    async trash(root, path, endpoint, expected, own) {
      await base.trash(root, path, endpoint, expected, own);
      location = endpoint;
      // The move landed, the guard did not hold, and the entry could not be put back.
      throw new FileError(
        "STRANDED",
        `the change at ${path} could not be completed; the entry is preserved at ${endpoint}`,
        undefined,
        endpoint,
      );
    },
    internal: {
      ...base.internal,
      async describe(root, path) {
        if (down) throw new FileError("FILES_RESTARTING", "the process is still down");
        return base.internal.describe(root, path);
      },
    },
    async shallow() {
      if (down) throw new FileError("FILES_RESTARTING", "the process is still down");
      return null;
    },
  }));
  const f = await setup({ workspaceIo: io, now: () => now, retentionMs: 10 });
  const client = await f.connect();
  await writeFile(join(f.root, "report.md"), "quarterly\n");

  const reply = await client.request({
    op: "delete",
    path: "report.md",
    expected: await version(client, "report.md"),
  });
  // A distinct outcome, carrying the recovery id, never a plain success or a plain refusal.
  expect(reply).toMatchObject({ type: "files.error", code: "STRANDED", recovery: location });
  expect(await readFile(join(f.root, location), "utf8")).toBe("quarterly\n");

  // The receipt stays exempt from expiry until something can prove where the entry is.
  await new Promise((resolve) => setTimeout(resolve, 25));
  now += 10_000;
  await f.service.sweep();
  expect(await readFile(join(f.root, location), "utf8")).toBe("quarterly\n");
  const pending = z
    .object({
      value: z.object({ entries: z.array(z.object({ id: z.string(), expires: z.number() })) }),
    })
    .parse(await client.request({ op: "trash.list", limit: 32 }));
  expect(pending.value.entries).toEqual([
    expect.objectContaining({ expires: Number.MAX_SAFE_INTEGER }),
  ]);

  // A start proves the entry is the one the receipt moved, and it becomes restorable.
  down = false;
  const [entry] = pending.value.entries;
  if (!entry) throw new Error("the failed rollback left no receipt");
  await f.restart();
  const next = await f.connect();
  expect(
    await next.request({ op: "restore", path: "report.md", trashId: entry.id, expected: null }),
  ).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "report.md"), "utf8")).toBe("quarterly\n");
});

it("finishes a journaled case-only rename a start finds at its staging name", async () => {
  let folding = true;
  let dataDir = "";
  let journaled: string | undefined;
  const io = await port((base) => ({
    async shallow(root, path, options) {
      // A volume that folds the spellings answers both names with the one entry.
      if (folding && (path === "Notes.md" || path === "notes.md"))
        return { version: "1:2:3:4:5", shallow: false, size: 8, kind: "file", mode: 0o644 };
      return base.shallow(root, path, options);
    },
    async move(root, from, _to, _expected, _own, staging) {
      // The staging name must be on disk in the journal before the entry leaves its spelling.
      const database = new DatabaseSync(join(dataDir, "files.sqlite"));
      try {
        const row = z
          .object({ body: z.string() })
          .optional()
          .parse(database.prepare("SELECT body FROM resources WHERE kind='move'").get());
        journaled = row
          ? z.object({ staging: z.string() }).parse(JSON.parse(row.body)).staging
          : undefined;
      } finally {
        database.close();
      }
      if (!staging) throw new Error("a case-only move must carry its journaled staging name");
      await rename(join(root, from), join(root, staging));
      throw new FileError("FILES_RESTARTING", "the process went away between the two steps");
    },
  }));
  const f = await setup({ workspaceIo: io });
  dataDir = join(f.home, "data");
  const client = await f.connect();
  await writeFile(join(f.root, "Notes.md"), "original");

  expect(
    await client.request({
      op: "rename",
      path: "Notes.md",
      expected: await version(client, "Notes.md"),
      destination: "notes.md",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.error", code: "FILES_RESTARTING" });
  expect(journaled).toMatch(/^\.ace-upload-move-/);
  expect(await readdir(f.root)).toEqual([expect.stringMatching(/^\.ace-upload-move-/)]);

  // A start finds the entry at the journaled name and finishes the move the client asked for.
  folding = false;
  await f.restart();
  await f.connect();
  expect(await readFile(join(f.root, "notes.md"), "utf8")).toBe("original");
  const database = new DatabaseSync(join(f.home, "data", "files.sqlite"));
  try {
    expect(
      z
        .object({ n: z.number() })
        .parse(database.prepare("SELECT count(*) AS n FROM resources WHERE kind='move'").get()).n,
    ).toBe(0);
  } finally {
    database.close();
  }
});

it("drops a delete's receipt when the port refuses before it moves anything", async () => {
  const io = await port(() => ({
    async trash(): Promise<void> {
      throw new FileError("CONFLICT", "the entry changed", "1:2:3:4:5");
    },
    async shallow() {
      throw new Error("a refused delete never asks where the entry went");
    },
  }));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();
  await writeFile(join(f.root, "report.md"), "quarterly\n");

  expect(
    await client.request({
      op: "delete",
      path: "report.md",
      expected: await version(client, "report.md"),
    }),
  ).toMatchObject({ type: "files.error", code: "CONFLICT" });
  expect(await readFile(join(f.root, "report.md"), "utf8")).toBe("quarterly\n");
  expect(await client.request({ op: "trash.list", limit: 32 })).toMatchObject({
    value: { entries: [] },
  });
});

it("reports the version the port read from the file it saved", async () => {
  const io = await port(() => ({
    async write(root, path, bytes, expected) {
      const saved = localFilesIo((target) => SafeRoot.create(target));
      await saved.write(root, path, bytes, expected);
      return "11:22:33:44:55";
    },
  }));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();

  expect(
    await client.request({ op: "create", path: "saved.md", expected: null, text: "hello" }),
  ).toMatchObject({ type: "files.result", value: { version: "11:22:33:44:55" } });
  expect(client.changes).toContainEqual(
    expect.objectContaining({
      change: expect.objectContaining({ path: "saved.md", version: "11:22:33:44:55" }),
    }),
  );
});

it("reports the version the port read from the folder and the file it committed", async () => {
  const io = await port((base) => ({
    async createDir(root, path) {
      await base.createDir(root, path);
      return "tree:made";
    },
    async move(...args: Parameters<FilesIo["move"]>) {
      await base.move(...args);
      return { version: "11:22:33:44:55", identity: null, recovery: null };
    },
  }));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();

  expect(await client.request({ op: "mkdir", path: "made", expected: null })).toMatchObject({
    type: "files.result",
    value: { version: "tree:made" },
  });
  await writeFile(join(f.root, "a.md"), "a\n");
  expect(
    await client.request({
      op: "rename",
      path: "a.md",
      expected: await version(client, "a.md"),
      destination: "b.md",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result", value: { version: "11:22:33:44:55" } });
});

it("reports a new folder's version as unknown when its identity cannot be proven", async () => {
  const io = await port((base) => ({
    async createDir(root, path) {
      await base.createDir(root, path);
      return null;
    },
  }));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();

  expect(await client.request({ op: "mkdir", path: "made", expected: null })).toMatchObject({
    type: "files.result",
    value: { version: null },
  });
});

it("reports a moved folder's digest only while its identity still matches", async () => {
  const f = await setup();
  const client = await f.connect();
  await mkdir(join(f.root, "docs"));
  await writeFile(join(f.root, "docs/a"), "a");
  expect(
    await client.request({
      op: "rename",
      path: "docs",
      expected: await version(client, "docs"),
      destination: "moved",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result", value: { version: expect.stringMatching(/^tree:/) } });

  let root = "";
  const swapping = await port((base) => ({
    async move(...args: Parameters<FilesIo["move"]>) {
      const outcome = await base.move(...args);
      // Another program replaces the moved folder before the digest is read after the queue.
      await rename(join(root, "moved"), join(root, "elsewhere"));
      await mkdir(join(root, "moved"));
      await writeFile(join(root, "moved/impostor"), "x");
      return outcome;
    },
  }));
  const g = await setup({ workspaceIo: swapping });
  root = g.root;
  const other = await g.connect();
  await mkdir(join(g.root, "docs"));
  await writeFile(join(g.root, "docs/a"), "a");

  expect(
    await other.request({
      op: "rename",
      path: "docs",
      expected: await version(other, "docs"),
      destination: "moved",
      destinationExpected: null,
    }),
  ).toMatchObject({ type: "files.result", value: { version: null } });
  expect(await readFile(join(g.root, "moved/impostor"), "utf8")).toBe("x");
});

it("reports a committed move even when its version cannot be read afterwards", async () => {
  let moved = false;
  const io = await port((base) => ({
    async move(...args: Parameters<FilesIo["move"]>) {
      await base.move(...args);
      moved = true;
      // The move landed; the port could not read the moved entry's version afterwards.
      return { version: null, identity: null, recovery: null };
    },
    async describe(root, path, options) {
      if (moved) throw new FileError("FILES_RESTARTING", "the process is restarting");
      return base.describe(root, path, options);
    },
  }));
  const f = await setup({ workspaceIo: io });
  const client = await f.connect();
  await writeFile(join(f.root, "a.md"), "a\n");

  const result = await client.request({
    op: "rename",
    path: "a.md",
    expected: await version(client, "a.md"),
    destination: "b.md",
    destinationExpected: null,
  });

  // The move landed; a metadata read that failed afterwards is not a failed move.
  expect(result).toMatchObject({ type: "files.result", value: { path: "a.md", version: null } });
  expect(await readFile(join(f.root, "b.md"), "utf8")).toBe("a\n");
  expect(client.changes).toContainEqual(
    expect.objectContaining({ change: expect.objectContaining({ destination: "b.md" }) }),
  );
});
