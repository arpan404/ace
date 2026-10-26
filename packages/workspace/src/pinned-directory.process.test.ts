import { closeSync, readSync, utimesSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import {
  lstat,
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { TestContext } from "vitest";
import { z } from "zod";
import { PinnedDirectory } from "./index.ts";

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
    await symlink(join(root, "legacy"), join(root, "next"));
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

// Windows cases. Directory links are junctions, which need no privilege.
const windowsOnly = test.runIf(process.platform === "win32");
const junction = (target: string, path: string) => symlink(target, path, "junction");
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
    await junction(join(root, "directory"), join(root, "junction"));
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
    await junction(outside, join(root, "junction"));
    const directory = PinnedDirectory.open(root);
    try {
      await rename(root, pinned);
      await junction(outside, root);
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
      await mkdir(join(root, "target"));
      await junction(join(root, "target"), join(root, "junction"));
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

windowsOnly(
  "Windows publication follows its pinned directory when a pathname is replaced with a junction",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await mkdir(join(root, "legacy"));
    await writeFile(join(root, "legacy/ace.db"), "leave legacy alone");
    const parent = PinnedDirectory.atBoundary(root),
      next = parent.mkdir("next");
    try {
      await rename(join(root, "next"), join(root, "detached"));
      await junction(join(root, "legacy"), join(root, "next"));
      next.publish("marker.json", '{"complete":true}\n');
      expect(await readFile(join(root, "detached/marker.json"), "utf8")).toBe(
        '{"complete":true}\n',
      );
      expect(await readdir(join(root, "legacy"))).toEqual(["ace.db"]);
      expect(await readFile(join(root, "legacy/ace.db"), "utf8")).toBe("leave legacy alone");
    } finally {
      next.closeSync();
      parent.closeSync();
    }
  },
);

windowsOnly(
  "Windows directory creation and removal refuse invalid names and keep a non-empty directory",
  async ({ onTestFinished }) => {
    const root = await scratch(onTestFinished);
    await mkdir(join(root, "full", "inner"), { recursive: true });
    await writeFile(join(root, "full", "kept.txt"), "kept");
    const directory = PinnedDirectory.open(root);
    try {
      for (const name of ["CON", "aux.txt", "a:b", "trail.", "trail ", "a*b", "..", ""]) {
        expect(() => directory.mkdir(name)).toThrowError(code("EINVAL"));
        expect(() => directory.removeDirectory(name)).toThrowError(code("EINVAL"));
      }
      expect(() => directory.removeDirectory("full")).toThrowError(code("ENOTEMPTY"));
      expect(directory.names()).toEqual(["full"]);
    } finally {
      directory.closeSync();
    }
    expect((await readdir(join(root, "full"))).toSorted()).toEqual(["inner", "kept.txt"]);
    expect(await readFile(join(root, "full", "kept.txt"), "utf8")).toBe("kept");
  },
);

// The add-on boundary itself, below the TypeScript name rules: arguments arrive unchecked.
type Native = (...args: unknown[]) => unknown;
const native = z.custom<Native>((value) => typeof value === "function");
const NativeBinding = z.object({
  openRoot: native,
  openAt: native,
  openMetadataAt: native,
  mkdirAt: native,
  renameAt: native,
  statFd: native,
  names: native,
});
function addon() {
  return NativeBinding.parse(createRequire(import.meta.url)("../dist/descriptor.node"));
}
const nativeFd = (value: unknown) => z.number().int().nonnegative().parse(value);
function readAll(descriptor: number): string {
  const bytes = Buffer.alloc(64);
  return bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString();
}

windowsOnly(
  "Windows listings return exactly their limit, refuse more and reject invalid limits",
  async ({ onTestFinished }) => {
    const core = addon();
    const root = await scratch(onTestFinished);
    const listed = (parent: number, limit: unknown) =>
      z.array(z.string()).parse(core.names(parent, limit)).toSorted();
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), name);
    const three = nativeFd(core.openRoot(root));
    try {
      expect(listed(three, 3)).toEqual(["a.txt", "b.txt", "c.txt"]);
      // A repeated listing restarts enumeration instead of continuing it.
      expect(listed(three, 3)).toEqual(["a.txt", "b.txt", "c.txt"]);
      for (const limit of [2, 1])
        expect(() => core.names(three, limit)).toThrowError(code("E2BIG"));
      for (const limit of [0, -1, 10_001, 1.5, Number.NaN, "3"])
        expect(() => core.names(three, limit)).toThrowError(code("EINVAL"));
    } finally {
      closeSync(three);
    }
    await mkdir(join(root, "empty"));
    const empty = nativeFd(core.openRoot(join(root, "empty")));
    try {
      expect(listed(empty, 1)).toEqual([]);
      expect(listed(empty, 10_000)).toEqual([]);
    } finally {
      closeSync(empty);
    }
    // More entries than one 64 KiB enumeration batch holds.
    await mkdir(join(root, "batches"));
    const wanted: string[] = [];
    for (let index = 0; index < 800; index++) {
      wanted.push(`entry-${"x".repeat(60)}-${String(index).padStart(4, "0")}`);
      await writeFile(join(root, "batches", wanted.at(-1) ?? ""), "x");
    }
    const batches = nativeFd(core.openRoot(join(root, "batches")));
    try {
      expect(listed(batches, 800)).toEqual(wanted.toSorted());
      expect(() => core.names(batches, 799)).toThrowError(code("E2BIG"));
      expect(listed(batches, 800)).toEqual(wanted.toSorted());
    } finally {
      closeSync(batches);
    }
  },
);

windowsOnly(
  "Windows malformed, closed and huge descriptors fail cleanly and a valid one still works",
  async ({ onTestFinished }) => {
    const core = addon();
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "ok.txt"), "ok");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", 2 ** 31, 2 ** 32]) {
      expect(() => core.openAt(bad, "ok.txt")).toThrowError(code("EINVAL"));
      expect(() => core.statFd(bad)).toThrowError(code("EINVAL"));
      expect(() => core.names(bad, 10)).toThrowError(code("EINVAL"));
    }
    const closed = nativeFd(core.openRoot(root));
    closeSync(closed);
    for (const bad of [closed, 999_999, 2 ** 31 - 1]) {
      expect(() => core.openAt(bad, "ok.txt")).toThrowError(code("EBADF"));
      expect(() => core.statFd(bad)).toThrowError(code("EBADF"));
      expect(() => core.names(bad, 10)).toThrowError(code("EBADF"));
    }
    const parent = nativeFd(core.openRoot(root));
    try {
      const file = nativeFd(core.openAt(parent, "ok.txt"));
      try {
        expect(readAll(file)).toBe("ok");
      } finally {
        closeSync(file);
      }
    } finally {
      closeSync(parent);
    }
  },
);

windowsOnly(
  "Windows metadata handles refuse content reads and writes",
  async ({ onTestFinished }) => {
    const core = addon();
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "file.txt"), "intact");
    const parent = nativeFd(core.openRoot(root));
    try {
      const metadata = nativeFd(core.openMetadataAt(parent, "file.txt"));
      try {
        expect(() => readSync(metadata, Buffer.alloc(1), 0, 1, 0)).toThrow();
        expect(() => writeSync(metadata, Buffer.from("!"), 0, 1, 0)).toThrow();
      } finally {
        closeSync(metadata);
      }
    } finally {
      closeSync(parent);
    }
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("intact");
  },
);

windowsOnly(
  "Windows junction handles never become traversal parents",
  async ({ onTestFinished }) => {
    const core = addon();
    const root = await scratch(onTestFinished);
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "sentinel.txt"), "outside bytes");
    await junction(join(root, "outside"), join(root, "junction"));
    const parent = nativeFd(core.openRoot(root));
    try {
      const link = nativeFd(core.openMetadataAt(parent, "junction"));
      try {
        expect(() => core.openAt(link, "sentinel.txt")).toThrowError(code("ELOOP"));
        expect(() => core.openMetadataAt(link, "sentinel.txt")).toThrowError(code("ELOOP"));
        expect(() => core.mkdirAt(link, "created")).toThrowError(code("ELOOP"));
        expect(() => core.names(link, 10)).toThrowError(code("ELOOP"));
      } finally {
        closeSync(link);
      }
      expect(() => core.openAt(parent, "junction")).toThrowError(code("ELOOP"));
    } finally {
      closeSync(parent);
    }
    expect(await readdir(join(root, "outside"))).toEqual(["sentinel.txt"]);
  },
);

windowsOnly(
  "Windows rename refuses an invalid source or destination component",
  async ({ onTestFinished }) => {
    const core = addon();
    const root = await scratch(onTestFinished);
    await writeFile(join(root, "file.txt"), "intact");
    const parent = nativeFd(core.openRoot(root));
    try {
      for (const bad of ["", ".", "..", "a\\b", "a/b", "nul\0tail", 7]) {
        expect(() => core.renameAt(parent, bad, "moved.txt")).toThrowError(code("EINVAL"));
        expect(() => core.renameAt(parent, "file.txt", bad)).toThrowError(code("EINVAL"));
      }
    } finally {
      closeSync(parent);
    }
    expect(await readdir(root)).toEqual(["file.txt"]);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("intact");
  },
);
