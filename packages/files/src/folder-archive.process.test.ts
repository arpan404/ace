import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FolderArchiveError, measureFolder, packFolder, unpackArchive } from "./index.ts";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "ace-folder-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "src");
  const destination = join(root, "dest");
  await mkdir(source);
  await mkdir(destination);
  return { root, source, destination, archive: join(root, "folder.tar") };
}
async function listen(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return server;
}
async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

it("round-trips a folder with nested files, empty dirs, modes, binaries and inside links", async () => {
  const t = await temp();
  const binary = randomBytes(300_001);
  await mkdir(join(t.source, "nested", "deeper"), { recursive: true });
  await mkdir(join(t.source, "empty"));
  await writeFile(join(t.source, ".env"), "dotfile");
  await writeFile(join(t.source, "nested", "deeper", "notes.txt"), "deep text");
  await writeFile(join(t.source, "blob.bin"), binary);
  await writeFile(join(t.source, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(t.source, "run.sh"), 0o755);
  await writeFile(join(t.source, "private"), "secret");
  await chmod(join(t.source, "private"), 0o600);
  await utimes(join(t.source, "nested", "deeper", "notes.txt"), 1_600_000_000, 1_600_000_000);
  await symlink("nested/deeper/notes.txt", join(t.source, "notes-link"));
  await symlink("../deeper", join(t.source, "nested", "deeper-link"));
  const long = `${"long-name-".repeat(14)}end`;
  await writeFile(join(t.source, "nested", long), "long name");
  await symlink(`nested/${long}`, join(t.source, "long-link"));

  const packed = await packFolder(t.source, t.archive);
  expect(packed.sha256).toBe(await sha256(t.archive));
  expect(packed.bytes).toBe((await stat(t.archive)).size);
  expect(packed.skipped).toBe(0);
  const unpacked = await unpackArchive(t.archive, t.destination);
  expect(unpacked.entries).toBe(packed.entries);

  const out = (path: string) => join(t.destination, path);
  expect(await readFile(out(".env"), "utf8")).toBe("dotfile");
  expect(await readFile(out("nested/deeper/notes.txt"), "utf8")).toBe("deep text");
  expect(Buffer.compare(await readFile(out("blob.bin")), binary)).toBe(0);
  expect(await readFile(out(`nested/${long}`), "utf8")).toBe("long name");
  expect(await readdir(out("empty"))).toEqual([]);
  expect((await stat(out("run.sh"))).mode & 0o777).toBe(0o755);
  expect((await stat(out("private"))).mode & 0o777).toBe(0o600);
  expect(Math.floor((await stat(out("nested/deeper/notes.txt"))).mtimeMs / 1000)).toBe(
    1_600_000_000,
  );
  expect((await lstat(out("notes-link"))).isSymbolicLink()).toBe(true);
  expect(await readlink(out("notes-link"))).toBe("nested/deeper/notes.txt");
  expect(await readFile(out("notes-link"), "utf8")).toBe("deep text");
  expect(await readlink(out("nested/deeper-link"))).toBe("../deeper");
  expect(await readFile(out("long-link"), "utf8")).toBe("long name");
});

it("skips sockets and links that leave the folder, and counts them", async () => {
  const t = await temp();
  await writeFile(join(t.source, "kept.txt"), "kept");
  await mkdir(join(t.source, "dir"));
  await symlink("../../outside", join(t.source, "dir", "climbs-out"));
  await symlink(t.root, join(t.source, "absolute"));
  // Lexically inside, but it climbs through another link that leads out.
  await symlink("..", join(t.source, "dir", "up"));
  await symlink("dir/up/..", join(t.source, "through-link"));
  await listen(join(t.source, "daemon.sock"));

  const packed = await packFolder(t.source, t.archive);
  expect(packed.skipped).toBe(4);
  await unpackArchive(t.archive, t.destination);
  expect((await readdir(t.destination)).toSorted()).toEqual(["dir", "kept.txt"]);
  expect(await readdir(join(t.destination, "dir"))).toEqual(["up"]);
  expect(await readlink(join(t.destination, "dir", "up"))).toBe("..");
});

it("measures exactly the bytes and entries that packing writes", async () => {
  const t = await temp();
  await mkdir(join(t.source, "a", "b"), { recursive: true });
  await writeFile(join(t.source, "a", "b", "c"), randomBytes(1_025));
  await writeFile(join(t.source, "x".repeat(150)), "long");
  await symlink("a/b/c", join(t.source, "link"));
  await listen(join(t.source, "s.sock"));

  const measured = await measureFolder(t.source);
  const packed = await packFolder(t.source, t.archive);
  expect(measured).toEqual({
    bytes: packed.bytes,
    entries: packed.entries,
    skipped: packed.skipped,
  });
  expect(packed.entries).toBe(5);
});

it("refuses to pack past maxBytes and leaves no partial archive behind", async () => {
  const t = await temp();
  await writeFile(join(t.source, "big"), randomBytes(2 * 1024 * 1024));
  const failure = await packFolder(t.source, t.archive, { maxBytes: 1024 * 1024 }).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(FolderArchiveError);
  expect(failure).toMatchObject({ code: "TOO_LARGE" });
  await expect(stat(t.archive)).rejects.toMatchObject({ code: "ENOENT" });
});

it("never overwrites an existing archive file", async () => {
  const t = await temp();
  await writeFile(join(t.source, "a"), "a");
  await writeFile(t.archive, "keep me");
  await expect(packFolder(t.source, t.archive)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(t.archive, "utf8")).toBe("keep me");
});

it("stops packing when cancelled mid-write and removes the partial archive", async () => {
  const t = await temp();
  const handle = await open(join(t.source, "big"), "w");
  const block = randomBytes(1024 * 1024);
  for (let index = 0; index < 128; index++) await handle.write(block);
  await handle.close();
  const controller = new AbortController();
  const packing = packFolder(t.source, t.archive, { signal: controller.signal });
  for (;;) {
    const written = await stat(t.archive).catch(() => undefined);
    if (written && written.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  await expect(packing).rejects.toMatchObject({ code: "ABORTED" });
  await expect(stat(t.archive)).rejects.toMatchObject({ code: "ENOENT" });
});

it("streams a large file through pack and unpack without holding it in memory", async () => {
  const t = await temp();
  const size = 192 * 1024 * 1024;
  const block = randomBytes(1024 * 1024);
  const expected = createHash("sha256");
  const handle = await open(join(t.source, "large.bin"), "w");
  for (let written = 0; written < size; written += block.length) {
    await handle.write(block);
    expected.update(block);
  }
  await handle.close();

  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    await packFolder(t.source, t.archive);
    await unpackArchive(t.archive, t.destination);
  } finally {
    clearInterval(sampler);
  }
  expect(peak - baseline).toBeLessThan(96 * 1024 * 1024);
  expect(await sha256(join(t.destination, "large.bin"))).toBe(expected.digest("hex"));
});

const windows = process.platform === "win32";
/** Headers as an independent tar reader sees them. */
async function windowsMembers(file: string) {
  const extract = tar.extract();
  const members: { name: string; type: string; linkname?: string | null }[] = [];
  extract.on("entry", (header, stream, next) => {
    members.push({ name: header.name, type: header.type ?? "", linkname: header.linkname });
    stream.on("end", next);
    stream.resume();
  });
  await pipeline(createReadStream(file), extract);
  return members;
}

it.runIf(windows)(
  "Windows: round-trips nested files, empty dirs, binaries, read-only files, Unicode and long paths",
  async () => {
    const t = await temp();
    const binary = randomBytes(300_001);
    const deep = Array.from({ length: 4 }, (_, index) => `${"d".repeat(70)}${index}`);
    await mkdir(join(t.source, ...deep), { recursive: true });
    await mkdir(join(t.source, "empty"));
    await writeFile(join(t.source, ".env"), "dotfile");
    await writeFile(join(t.source, "blob.bin"), binary);
    await writeFile(join(t.source, "界 ünïcode.txt"), "unicode");
    await writeFile(join(t.source, ...deep, "deep.txt"), "deep text");
    await utimes(join(t.source, ...deep, "deep.txt"), 1_600_000_000, 1_600_000_000);
    await writeFile(join(t.source, "locked.txt"), "read only");
    await chmod(join(t.source, "locked.txt"), 0o444);
    expect(join(t.destination, ...deep, "deep.txt").length).toBeGreaterThan(260);

    const packed = await packFolder(t.source, t.archive);
    expect(packed.sha256).toBe(await sha256(t.archive));
    expect(packed.skipped).toBe(0);
    expect(await measureFolder(t.source)).toEqual({
      bytes: packed.bytes,
      entries: packed.entries,
      skipped: 0,
    });
    const unpacked = await unpackArchive(t.archive, t.destination);
    expect(unpacked.entries).toBe(packed.entries);

    const out = (...path: string[]) => join(t.destination, ...path);
    expect(await readFile(out(".env"), "utf8")).toBe("dotfile");
    expect(Buffer.compare(await readFile(out("blob.bin")), binary)).toBe(0);
    expect(await readFile(out("界 ünïcode.txt"), "utf8")).toBe("unicode");
    expect(await readFile(out(...deep, "deep.txt"), "utf8")).toBe("deep text");
    expect(Math.floor((await stat(out(...deep, "deep.txt"))).mtimeMs / 1000)).toBe(1_600_000_000);
    expect(await readdir(out("empty"))).toEqual([]);
    expect((await stat(out("locked.txt"))).mode & 0o200).toBe(0);
    expect((await stat(out("blob.bin"))).mode & 0o200).toBe(0o200);
    await chmod(join(t.source, "locked.txt"), 0o666);
    await chmod(out("locked.txt"), 0o666);
  },
);

it.runIf(windows)(
  "Windows: packs links with portable targets, skips junctions leaving the folder, and unpacks no links",
  async () => {
    const t = await temp();
    await writeFile(join(t.source, "kept.txt"), "kept");
    await mkdir(join(t.source, "dir"));
    await symlink("..\\kept.txt", join(t.source, "dir", "back"));
    await symlink(t.root, join(t.source, "junction"), "junction");
    await symlink(t.root, join(t.source, "absolute"));

    const packed = await packFolder(t.source, t.archive);
    expect(packed.skipped).toBe(2);
    expect(await measureFolder(t.source)).toEqual({
      bytes: packed.bytes,
      entries: packed.entries,
      skipped: 2,
    });
    expect(await windowsMembers(t.archive)).toContainEqual(
      expect.objectContaining({ name: "dir/back", type: "symlink", linkname: "../kept.txt" }),
    );
    const unpacked = await unpackArchive(t.archive, t.destination);
    expect(unpacked.entries).toBe(packed.entries - 1);
    expect((await readdir(t.destination)).toSorted()).toEqual(["dir", "kept.txt"]);
    expect(await readdir(join(t.destination, "dir"))).toEqual([]);
    expect(await readdir(t.root)).toEqual(expect.arrayContaining(["dest", "src"]));
  },
);
