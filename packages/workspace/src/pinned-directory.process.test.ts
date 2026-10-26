import { closeSync, readSync, utimesSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { PinnedDirectory } from "./index.ts";

const windowsOnly = test.runIf(process.platform === "win32");
/** A directory link: a junction on Windows, which needs no privilege; elsewhere a symlink. */
function link(target: string, path: string): Promise<void> {
  return process.platform === "win32" ? symlink(target, path, "junction") : symlink(target, path);
}

test("publication follows its pinned inode when a pathname is replaced with a legacy-home link", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-pinned-publication-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "legacy"));
  await writeFile(join(root, "legacy/ace.db"), "leave legacy alone");
  const parent = PinnedDirectory.atBoundary(root),
    next = parent.mkdir("next");
  try {
    await rename(join(root, "next"), join(root, "detached"));
    await link(join(root, "legacy"), join(root, "next"));
    next.publish("marker.json", '{"complete":true}\n');
    expect(await readFile(join(root, "detached/marker.json"), "utf8")).toBe('{"complete":true}\n');
    expect(await readdir(join(root, "legacy"))).toEqual(["ace.db"]);
    expect(await readFile(join(root, "legacy/ace.db"), "utf8")).toBe("leave legacy alone");
  } finally {
    next.closeSync();
    parent.closeSync();
  }
});

test("bounded regular-file reads refuse links, directories and oversized files", async ({
  onTestFinished,
  skip,
}) => {
  // File symlinks need a Windows privilege, and owner checks need POSIX mode bits.
  skip(process.platform === "win32");
  const root = await mkdtemp(join(tmpdir(), "ace-pinned-read-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "regular"), "safe", { mode: 0o600 });
  await writeFile(join(root, "large"), "x".repeat(17));
  await symlink("regular", join(root, "link"));
  await mkdir(join(root, "directory"));
  const directory = PinnedDirectory.atBoundary(root);
  try {
    expect(directory.readText("regular", 16, directory.stat().uid)).toBe("safe");
    for (const name of ["link", "directory", "large"])
      expect(() => directory.readText(name, 16)).toThrow();
    expect(directory.empty()).toBe(false);
    expect(directory.empty()).toBe(false);
  } finally {
    directory.closeSync();
  }
});

async function scratch(onTestFinished: TestContext["onTestFinished"]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-pinned-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
const code = (name: string) => expect.objectContaining({ code: name });
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

windowsOnly(
  "Windows bounded reads refuse junctions, directories and oversized files",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "regular"), "safe");
    await writeFile(join(root, "large"), "x".repeat(17));
    await mkdir(join(root, "directory"));
    await link(join(root, "directory"), join(root, "junction"));
    const directory = PinnedDirectory.open(root);
    try {
      expect(directory.readText("regular", 16)).toBe("safe");
      for (const name of ["junction", "directory", "large"])
        expect(() => directory.readText(name, 16)).toThrow();
      expect(() => directory.child("junction")).toThrowError(code("ELOOP"));
      expect(() => directory.child("regular")).toThrowError(code("ENOTDIR"));
    } finally {
      directory.closeSync();
    }
  },
);

windowsOnly(
  "Windows pinned creation, publication and deletion ignore a replaced ancestor",
  async ({ onTestFinished }) => {
    const base = await scratch(onTestFinished);
    const root = join(base, "root");
    const pinned = join(base, "pinned");
    const outside = join(base, "outside");
    await mkdir(join(root, "directory"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "same.txt"), "inside");
    await writeFile(join(outside, "same.txt"), "outside");
    await link(outside, join(root, "junction"));
    const directory = PinnedDirectory.open(root);
    try {
      await rename(root, pinned);
      await link(outside, root);
      for (const name of ["same.txt", "directory", "junction"])
        expect(() => directory.createExclusive(name)).toThrowError(code("EEXIST"));
      await directory.writeExclusive("new.txt", "stays in the pinned directory");
      directory.replace("target.txt", "inside target");
      expect(() => directory.publish("target.txt", "must not replace")).toThrow();
      directory.unlink("same.txt");
      directory.removeDirectory("junction");
      expect(() => directory.unlink("directory")).toThrowError(code("EISDIR"));
      expect(() => directory.removeDirectory("new.txt")).toThrowError(code("ENOTDIR"));
    } finally {
      directory.closeSync();
    }
    expect(await readFile(join(pinned, "new.txt"), "utf8")).toBe("stays in the pinned directory");
    expect(await readFile(join(pinned, "target.txt"), "utf8")).toBe("inside target");
    await expect(lstat(join(pinned, "junction"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(outside)).toSorted()).toEqual(["same.txt"]);
    expect(await readFile(join(outside, "same.txt"), "utf8")).toBe("outside");
  },
);

windowsOnly(
  "Windows file identity follows the open file and tells a replacement apart",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "slot.txt"), "original bytes");
    const directory = PinnedDirectory.open(root);
    try {
      const original = directory.fileMetadata("slot.txt");
      expect(same(directory.metadata("slot.txt"), original)).toBe(true);
      const fd = directory.openRead("slot.txt");
      try {
        await rename(join(root, "slot.txt"), join(root, "moved.txt"));
        await writeFile(join(root, "slot.txt"), "replacement bytes");
        expect(same(directory.fileMetadata("slot.txt"), original)).toBe(false);
        expect(same(directory.fileMetadata("moved.txt"), original)).toBe(true);
        const bytes = Buffer.alloc(64);
        expect(bytes.subarray(0, readSync(fd, bytes, 0, 64, 0)).toString()).toBe("original bytes");
      } finally {
        closeSync(fd);
      }
      const junction = join(root, "junction");
      await mkdir(join(root, "target"));
      await link(join(root, "target"), junction);
      expect(directory.metadata("junction").mode & 0o170000).toBe(0o120000);
      expect(same(directory.metadata("junction"), directory.metadata("target"))).toBe(false);
    } finally {
      directory.closeSync();
    }
  },
);

windowsOnly(
  "Windows enumeration keeps Unicode names across batches",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    const wanted = ["données-日本語-☃", "café-日本語-✓.txt"];
    await mkdir(join(root, "données-日本語-☃"));
    await writeFile(join(root, "café-日本語-✓.txt"), "unicode");
    for (let index = 0; index < 800; index++) {
      wanted.push(`batch-${String(index).padStart(4, "0")}.txt`);
      await writeFile(join(root, wanted.at(-1) ?? ""), "x");
    }
    const old = Date.UTC(1960, 4, 15, 12, 30, 45, 123);
    utimesSync(join(root, "café-日本語-✓.txt"), new Date(old), new Date(old));
    const directory = PinnedDirectory.open(root);
    try {
      expect(directory.names()).toEqual(wanted.toSorted());
      expect(directory.readText("café-日本語-✓.txt", 16)).toBe("unicode");
      expect(Math.abs(directory.metadata("café-日本語-✓.txt").mtime - old)).toBeLessThan(1);
    } finally {
      directory.closeSync();
    }
  },
);

windowsOnly(
  "Windows refuses reserved names, streams, UNC and drive-relative roots",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "file.txt"), "intact");
    const directory = PinnedDirectory.open(root);
    try {
      for (const name of ["CON", "nul.txt", "COM1 .log", "file.txt:stream", "trail.", "a*b"]) {
        expect(() => directory.createExclusive(name)).toThrowError(code("EINVAL"));
        expect(() => directory.metadata(name)).toThrowError(code("EINVAL"));
        expect(() => directory.unlink(name)).toThrowError(code("EINVAL"));
      }
      expect(directory.names()).toEqual(["file.txt"]);
    } finally {
      directory.closeSync();
    }
    expect(() => PinnedDirectory.open("\\\\server\\share\\dir")).toThrowError(code("ENOTSUP"));
    for (const path of ["\\\\?\\C:\\x", "C:foo", "C:", "\\foo"])
      expect(() => PinnedDirectory.open(path)).toThrowError(code("EINVAL"));
  },
);
