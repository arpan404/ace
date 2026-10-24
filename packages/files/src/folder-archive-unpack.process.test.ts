import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { afterEach, expect, it } from "vitest";
import { unpackArchive } from "./index.ts";

// Hostile archives come from tar-stream's own writer, independent of packFolder.
interface Member {
  name: string;
  type?: "file" | "directory" | "symlink" | "link" | "fifo";
  linkname?: string;
  content?: string;
  pax?: Record<string, string>;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "ace-unpack-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // dest sits two levels down so `..` and `../..` both land in folders this test watches.
  const outside = join(root, "outside");
  const destination = join(outside, "dest");
  await mkdir(destination, { recursive: true });
  return { root, outside, destination, archive: join(root, "crafted.tar") };
}
async function craft(file: string, members: Member[]): Promise<void> {
  const pack = tar.pack();
  const writing = pipeline(pack, createWriteStream(file));
  for (const member of members) {
    const { content, ...header } = member;
    await new Promise<void>((resolve, reject) =>
      pack.entry({ mode: 0o644, ...header }, content ?? "", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  pack.finalize();
  await writing;
}
async function refuses(members: Member[]) {
  const t = await temp();
  await craft(t.archive, members);
  await expect(unpackArchive(t.archive, t.destination)).rejects.toMatchObject({
    code: "UNSAFE_ENTRY",
  });
  return t;
}

it("refuses an entry that climbs out with ..", async () => {
  const t = await refuses([{ name: "../x", content: "escaped" }]);
  expect((await readdir(t.outside)).toSorted()).toEqual(["dest"]);
  expect(await readdir(t.root)).not.toContain("x");
});

it("refuses an entry with an absolute path", async () => {
  const t = await temp();
  const target = join(t.root, "absolute-escape");
  await craft(t.archive, [{ name: target, content: "escaped" }]);
  await expect(unpackArchive(t.archive, t.destination)).rejects.toMatchObject({
    code: "UNSAFE_ENTRY",
  });
  expect(await readdir(t.root)).not.toContain("absolute-escape");
  expect(await readdir(t.destination)).toEqual([]);
});

it("refuses a file written through a link stored earlier in the archive", async () => {
  const t = await temp();
  await craft(t.archive, [
    { name: "door", type: "symlink", linkname: t.outside },
    { name: "door/planted", content: "escaped" },
  ]);
  await expect(unpackArchive(t.archive, t.destination)).rejects.toMatchObject({
    code: "UNSAFE_ENTRY",
  });
  expect((await readdir(t.outside)).toSorted()).toEqual(["dest"]);
  expect(await readdir(t.destination)).toEqual([]);
});

it("refuses links whose target leaves the destination, creating none of them", async () => {
  await refuses([{ name: "up", type: "symlink", linkname: "../.." }]);
  await refuses([{ name: "abs", type: "symlink", linkname: "/etc" }]);
  const t = await refuses([
    { name: "fine.txt", content: "ok" },
    { name: "d", type: "directory" },
    { name: "d/up", type: "symlink", linkname: ".." },
    // Lexically "d", but resolved through d/up it lands above the destination.
    { name: "e", type: "symlink", linkname: "d/up/.." },
  ]);
  expect(await readdir(join(t.destination, "d"))).toEqual([]);
});

it("refuses hard links, FIFOs and unknown PAX keys", async () => {
  await refuses([
    { name: "a", content: "a" },
    { name: "b", type: "link", linkname: "a" },
  ]);
  await refuses([{ name: "pipe", type: "fifo" }]);
  await refuses([{ name: "a", content: "a", pax: { "SCHILY.xattr.user.x": "1" } }]);
});

it("refuses entries whose parent directory isn't in the archive", async () => {
  await refuses([{ name: "missing/child", content: "x" }]);
});

it("never replaces an entry written earlier in the same archive", async () => {
  const t = await refuses([
    { name: "same", content: "first" },
    { name: "same", content: "second" },
  ]);
  expect(await readdir(t.destination)).toEqual(["same"]);
});

it("refuses a destination that isn't empty", async () => {
  const t = await temp();
  await writeFile(join(t.destination, "existing"), "mine");
  await craft(t.archive, [{ name: "a", content: "a" }]);
  await expect(unpackArchive(t.archive, t.destination)).rejects.toMatchObject({
    code: "NOT_EMPTY",
  });
  expect(await readdir(t.destination)).toEqual(["existing"]);
});

it("refuses a file that isn't a tar archive", async () => {
  const t = await temp();
  await writeFile(t.archive, Buffer.alloc(2048, 7));
  await expect(unpackArchive(t.archive, t.destination)).rejects.toMatchObject({
    code: "UNSAFE_ENTRY",
  });
});
