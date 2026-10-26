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
import { PinnedDirectory, sameFile } from "./pinned-directory.ts";

const platform = process.platform;
const windowsOnly = test.runIf(platform === "win32");

/** A directory link: a junction on Windows, which needs no privilege; a symlink elsewhere. */
function linkDirectory(target: string, path: string): Promise<void> {
  return symlink(target, path, "junction");
}
/** Removes a directory link itself. Windows deletes a junction as a directory entry. */
function unlinkDirectoryLink(directory: PinnedDirectory, name: string): void {
  if (platform === "win32") directory.removeDirectory(name);
  else directory.unlink(name);
}
async function scratch(onTestFinished: TestContext["onTestFinished"]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-pinned-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
function code(name: string) {
  return expect.objectContaining({ code: name });
}
function readAll(fd: number): string {
  const bytes = Buffer.alloc(256);
  return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
}

test("publication follows its pinned inode when a pathname is replaced with a legacy-home link", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await mkdir(join(root, "legacy"));
  await writeFile(join(root, "legacy/ace.db"), "leave legacy alone");
  const parent = PinnedDirectory.atBoundary(root),
    next = parent.mkdir("next");
  try {
    await rename(join(root, "next"), join(root, "detached"));
    await linkDirectory(join(root, "legacy"), join(root, "next"));
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
}) => {
  const root = await scratch(onTestFinished);
  await writeFile(join(root, "regular"), "safe", { mode: 0o600 });
  await writeFile(join(root, "large"), "x".repeat(17));
  await mkdir(join(root, "directory"));
  await linkDirectory(join(root, "directory"), join(root, "directory-link"));
  const refused = ["directory-link", "directory", "large"];
  // File symlinks need a privilege on Windows; junctions cover links there.
  if (platform !== "win32") {
    await symlink("regular", join(root, "link"));
    refused.push("link");
  }
  const directory = PinnedDirectory.atBoundary(root);
  try {
    expect(directory.readText("regular", 16, process.getuid?.())).toBe("safe");
    for (const name of refused) expect(() => directory.readText(name, 16)).toThrow();
    expect(directory.empty()).toBe(false);
    expect(directory.empty()).toBe(false);
  } finally {
    directory.closeSync();
  }
});

test("creates a Unicode directory through its pinned parent and writes inside it", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await writeFile(join(root, "existing.txt"), "keep file");
  const parent = PinnedDirectory.open(root);
  try {
    const child = parent.mkdir("données-日本語");
    try {
      await child.writeExclusive("café-✓.txt", "nested bytes 😀");
      expect(child.names()).toEqual(["café-✓.txt"]);
    } finally {
      child.closeSync();
    }
    expect(await readFile(join(root, "données-日本語", "café-✓.txt"), "utf8")).toBe(
      "nested bytes 😀",
    );
    for (const name of ["données-日本語", "existing.txt"])
      expect(() => parent.mkdir(name)).toThrowError(code("EEXIST"));
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep file");
  } finally {
    parent.closeSync();
  }
});

test("exclusive creation keeps existing files, directories and link targets", async ({
  onTestFinished,
}) => {
  const base = await scratch(onTestFinished);
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "directory"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "existing.txt"), "keep existing bytes");
  await writeFile(join(outside, "keep.txt"), "outside bytes");
  await linkDirectory(outside, join(root, "link"));
  const directory = PinnedDirectory.open(root);
  try {
    for (const name of ["existing.txt", "directory", "link"])
      expect(() => directory.createExclusive(name)).toThrowError(code("EEXIST"));
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep existing bytes");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  } finally {
    directory.closeSync();
  }
});

test("a replaced ancestor cannot redirect pinned creation, publication or deletion", async ({
  onTestFinished,
}) => {
  const base = await scratch(onTestFinished);
  const root = join(base, "root");
  const pinned = join(base, "pinned");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "same.txt"), "inside");
  await writeFile(join(outside, "same.txt"), "outside");
  await writeFile(join(outside, "target.txt"), "outside target");
  await linkDirectory(outside, join(root, "link"));
  const directory = PinnedDirectory.open(root);
  try {
    await rename(root, pinned);
    await linkDirectory(outside, root);
    await directory.writeExclusive("new.txt", "stays in the pinned directory");
    directory.replace("target.txt", "inside target");
    directory.unlink("same.txt");
    unlinkDirectoryLink(directory, "link");
  } finally {
    directory.closeSync();
  }
  expect(await readFile(join(pinned, "new.txt"), "utf8")).toBe("stays in the pinned directory");
  expect(await readFile(join(pinned, "target.txt"), "utf8")).toBe("inside target");
  await expect(lstat(join(pinned, "same.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(pinned, "link"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(outside)).toSorted()).toEqual(["same.txt", "target.txt"]);
  expect(await readFile(join(outside, "same.txt"), "utf8")).toBe("outside");
  expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside target");
});

test("deletion keeps file and empty-directory semantics", async ({ onTestFinished }) => {
  const root = await scratch(onTestFinished);
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "directory", "keep.txt"), "keep");
  await writeFile(join(root, "café-日本語.txt"), "file");
  const parent = PinnedDirectory.open(root);
  try {
    expect(() => parent.unlink("directory")).toThrow();
    expect(() => parent.removeDirectory("café-日本語.txt")).toThrowError(code("ENOTDIR"));
    expect(() => parent.removeDirectory("directory")).toThrowError(code("ENOTEMPTY"));
    expect(await readFile(join(root, "directory", "keep.txt"), "utf8")).toBe("keep");
    const nested = parent.child("directory");
    try {
      nested.unlink("keep.txt");
    } finally {
      nested.closeSync();
    }
    parent.removeDirectory("directory");
    parent.unlink("café-日本語.txt");
    expect(await readdir(root)).toEqual([]);
    expect(() => parent.unlink("missing")).toThrowError(code("ENOENT"));
  } finally {
    parent.closeSync();
  }
});

test("replace publishes new bytes under an existing name while publish never replaces", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await writeFile(join(root, "café-日本語.txt"), "old bytes");
  const directory = PinnedDirectory.open(root);
  try {
    directory.replace("café-日本語.txt", "new flushed bytes 😀");
    directory.publish("marker.json", "published");
    expect(() => directory.publish("marker.json", "must not replace")).toThrow();
    expect(directory.names()).toEqual(["café-日本語.txt", "marker.json"]);
  } finally {
    directory.closeSync();
  }
  expect(await readFile(join(root, "café-日本語.txt"), "utf8")).toBe("new flushed bytes 😀");
  expect(await readFile(join(root, "marker.json"), "utf8")).toBe("published");
});

test("an open file keeps its identity and bytes when its name is replaced", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await writeFile(join(root, "slot.txt"), "original bytes");
  const directory = PinnedDirectory.open(root);
  try {
    const original = directory.fileMetadata("slot.txt").identity;
    expect(original.kind).toBe(platform === "win32" ? "win32" : "posix");
    expect(sameFile(directory.fileMetadata("slot.txt").identity, original)).toBe(true);
    const { fd, info } = directory.openReadIdentified("slot.txt");
    try {
      expect(sameFile(info.identity, original)).toBe(true);
      await rename(join(root, "slot.txt"), join(root, "moved.txt"));
      await writeFile(join(root, "slot.txt"), "replacement bytes");
      expect(sameFile(directory.fileMetadata("slot.txt").identity, original)).toBe(false);
      expect(sameFile(directory.fileMetadata("moved.txt").identity, original)).toBe(true);
      expect(sameFile(directory.metadata("moved.txt").identity, original)).toBe(true);
      expect(readAll(fd)).toBe("original bytes");
    } finally {
      closeSync(fd);
    }
  } finally {
    directory.closeSync();
  }
  expect(await readFile(join(root, "slot.txt"), "utf8")).toBe("replacement bytes");
});

test("link metadata describes the link itself and the link is never traversed", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await mkdir(join(root, "realdir"));
  await writeFile(join(root, "realdir", "sentinel.txt"), "target bytes");
  await linkDirectory(join(root, "realdir"), join(root, "link"));
  const directory = PinnedDirectory.open(root);
  try {
    const link = directory.metadata("link");
    expect(link.mode & 0o170000).toBe(0o120000);
    expect(directory.metadata("realdir").mode & 0o170000).toBe(0o040000);
    expect(sameFile(link.identity, directory.metadata("realdir").identity)).toBe(false);
    expect(() => directory.child("link")).toThrow();
    expect(() => directory.fileMetadata("link")).toThrow();
  } finally {
    directory.closeSync();
  }
  expect(await readFile(join(root, "realdir", "sentinel.txt"), "utf8")).toBe("target bytes");
});

test("an ancestor swapped for a link breaks a later open instead of redirecting it", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  await mkdir(join(root, "gate", "real"), { recursive: true });
  await writeFile(join(root, "gate", "real", "deep.txt"), "deep");
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "elsewhere", "deep.txt"), "impostor");
  const pinned = PinnedDirectory.open(join(root, "gate", "real"));
  try {
    await rename(join(root, "gate", "real"), join(root, "gate", "moved"));
    await linkDirectory(join(root, "elsewhere"), join(root, "gate", "real"));
    expect(() => PinnedDirectory.open(join(root, "gate", "real"))).toThrow();
    expect(pinned.matches(join(root, "gate", "moved"))).toBe(true);
    expect(pinned.readText("deep.txt", 16)).toBe("deep");
  } finally {
    pinned.closeSync();
  }
});

test("enumeration lists Unicode names across many batches without dot entries", async ({
  onTestFinished,
}) => {
  const root = await scratch(onTestFinished);
  const wanted = ["données-日本語-☃", "café-日本語-✓.txt"];
  await mkdir(join(root, wanted[0] ?? ""));
  await writeFile(join(root, wanted[1] ?? ""), "unicode");
  for (let index = 0; index < 800; index++) {
    const name = `batch-${String(index).padStart(4, "0")}.txt`;
    wanted.push(name);
    await writeFile(join(root, name), "x");
  }
  const directory = PinnedDirectory.open(root);
  try {
    expect(directory.names()).toEqual(wanted.toSorted());
    expect(directory.names()).toEqual(wanted.toSorted());
    const empty = directory.child(wanted[0] ?? "");
    try {
      expect(empty.names()).toEqual([]);
    } finally {
      empty.closeSync();
    }
  } finally {
    directory.closeSync();
  }
});

test("metadata reports a pre-1970 modification time as negative", async ({ onTestFinished }) => {
  const root = await scratch(onTestFinished);
  await writeFile(join(root, "old.txt"), "old bytes");
  const expected = Date.UTC(1960, 4, 15, 12, 30, 45, 123);
  utimesSync(join(root, "old.txt"), new Date(expected), new Date(expected));
  const directory = PinnedDirectory.open(root);
  try {
    const info = directory.metadata("old.txt");
    expect(info.size).toBe(Buffer.byteLength("old bytes"));
    expect(Math.abs(info.mtime - expected)).toBeLessThan(1);
  } finally {
    directory.closeSync();
  }
});

windowsOnly(
  "Windows reserved names, streams and trailing dots are refused by every pinned operation",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "file.txt"), "intact");
    const directory = PinnedDirectory.open(root);
    try {
      for (const name of [
        "CON",
        "con",
        "NUL.txt",
        "COM1",
        "lpt9",
        "AUX.log",
        "CON .txt",
        "COM1 .log",
        "NUL .tar.gz",
        "file.txt:stream",
        "trail.",
        "trail ",
        "...",
        "a\\b",
        "?",
        "a*b",
        'quote"name',
        "C:foo",
      ]) {
        expect(() => directory.createExclusive(name)).toThrowError(code("EINVAL"));
        expect(() => directory.mkdir(name)).toThrowError(code("EINVAL"));
        expect(() => directory.metadata(name)).toThrowError(code("EINVAL"));
        expect(() => directory.readText(name, 16)).toThrowError(code("EINVAL"));
        expect(() => directory.child(name)).toThrowError(code("EINVAL"));
        expect(() => directory.unlink(name)).toThrowError(code("EINVAL"));
      }
      expect(directory.names()).toEqual(["file.txt"]);
      expect(directory.readText("file.txt", 16)).toBe("intact");
    } finally {
      directory.closeSync();
    }
  },
);

windowsOnly("Windows UNC, device and drive-relative roots are refused", () => {
  expect(() => PinnedDirectory.open("\\\\server\\share\\dir")).toThrowError(
    expect.objectContaining({ code: "ENOTSUP", message: expect.stringMatching(/UNC/) }),
  );
  for (const root of ["\\\\?\\C:\\x", "C:foo", "C:", "\\foo", "/foo"])
    expect(() => PinnedDirectory.open(root)).toThrowError(code("EINVAL"));
});
