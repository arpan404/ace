import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import type { FileOperation } from "@ace/protocol";
import { encodeFileFrame } from "./index.ts";
import { fixture, type Client } from "./test-support.ts";

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
  expect(
    await client.request({ op: "write", path: "dir/a", expected: null, text: "bad" }),
  ).toMatchObject({ code: "PATH_ESCAPE" });
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
