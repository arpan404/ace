import { closeSync, constants, fstatSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { z } from "zod";
import { sameFile } from "./file-identity.ts";
import { createWindowsFilesystem } from "./windows-filesystem.ts";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
  openMetadataAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int().nonnegative(),
  }),
  statFd: z.function({ input: [z.number().int()], output: z.unknown() }),
  statAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.object({ vol: z.string(), id: z.string(), mode: z.number().int() }),
  }),
});
const win = test.runIf(process.platform === "win32");

async function fixture(prefix: string, onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

win("stats files and directories through pinned metadata", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const wfs = createWindowsFilesystem(core);
  const root = await fixture("ace-wfs-file-", onTestFinished);
  await writeFile(join(root, "hello-✓.txt"), "hello filesystem");
  await mkdir(join(root, "sub-日本語"));
  await writeFile(join(root, "sub-日本語", "nested.txt"), "nested");

  const file = await wfs.stat(join(root, "hello-✓.txt"));
  expect(file.isFile()).toBe(true);
  expect(file.isDirectory()).toBe(false);
  expect(file.size).toBe(Buffer.byteLength("hello filesystem"));
  expect(file.identity.kind).toBe("win32");
  expect(sameFile(file.identity, (await wfs.lstat(join(root, "hello-✓.txt"))).identity)).toBe(true);

  const dir = await wfs.stat(join(root, "sub-日本語"));
  expect(dir.isDirectory()).toBe(true);
  expect(dir.isFile()).toBe(false);
  expect(sameFile(dir.identity, (await wfs.lstat(join(root, "sub-日本語"))).identity)).toBe(true);

  const driveRoot = win32.parse(await wfs.realpath(root)).root;
  const drive = await wfs.stat(driveRoot);
  expect(drive.isDirectory()).toBe(true);
  expect(sameFile(drive.identity, (await wfs.lstat(driveRoot)).identity)).toBe(true);

  expect(await wfs.realpath(join(root, "hello-✓.txt"))).toContain("hello-✓.txt");
  const handle = await wfs.open(join(root, "hello-✓.txt"), constants.O_RDONLY);
  try {
    expect(await handle.readFile("utf8")).toBe("hello filesystem");
  } finally {
    await handle.close();
  }
});

win("follows junctions on stat while lstat reports the link", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const wfs = createWindowsFilesystem(core);
  const base = await fixture("ace-wfs-junction-", onTestFinished);
  const outside = join(base, "outside");
  const scope = join(base, "scope");
  await mkdir(outside);
  await mkdir(scope);
  await writeFile(join(outside, "sentinel.txt"), "outside");
  await symlink(outside, join(scope, "junction"), "junction");

  const followed = await wfs.stat(join(scope, "junction"));
  expect(followed.isDirectory()).toBe(true);
  expect(followed.isSymbolicLink()).toBe(false);
  expect(sameFile(followed.identity, (await wfs.stat(outside)).identity)).toBe(true);

  const link = await wfs.lstat(join(scope, "junction"));
  expect(link.isSymbolicLink()).toBe(true);
  expect(link.isDirectory()).toBe(false);
  expect(link.isFile()).toBe(false);
  expect(sameFile(link.identity, followed.identity)).toBe(false);
  for (const path of [join(scope, "junction") + "\\", join(scope, "junction") + "/"]) {
    const expected = await lstat(path);
    const observed = await wfs.lstat(path);
    expect(observed.isSymbolicLink()).toBe(expected.isSymbolicLink());
    expect(observed.isDirectory()).toBe(expected.isDirectory());
    expect(
      sameFile(observed.identity, expected.isSymbolicLink() ? link.identity : followed.identity),
    ).toBe(true);
  }

  const parent = core.openRoot(scope);
  try {
    const expected = core.statAt(parent, "junction");
    expect(link.identity).toEqual({ kind: "win32", vol: expected.vol, id: expected.id });
  } finally {
    closeSync(parent);
  }
  expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
});

win(
  "keeps the held observation when the pathname is replaced during stat",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const base = createWindowsFilesystem(core);
    const root = await fixture("ace-wfs-held-", onTestFinished);
    await writeFile(join(root, "slot.txt"), "original");
    const original = await base.stat(join(root, "slot.txt"));

    let replaced = false;
    const racing = createWindowsFilesystem({
      openRoot: (path) => core.openRoot(path),
      openMetadataAt: (parent, name) => core.openMetadataAt(parent, name),
      statFd: (fd) => {
        if (!replaced) {
          replaced = true;
          renameSync(join(root, "slot.txt"), join(root, "moved.txt"));
          writeFileSync(join(root, "slot.txt"), "replacement bytes longer");
        }
        return core.statFd(fd);
      },
    });
    const held = await racing.stat(join(root, "slot.txt"));
    expect(sameFile(held.identity, original.identity)).toBe(true);
    expect(held.size).toBe(Buffer.byteLength("original"));

    const current = await base.stat(join(root, "slot.txt"));
    expect(sameFile(current.identity, original.identity)).toBe(false);
    expect(current.size).toBe(Buffer.byteLength("replacement bytes longer"));
    expect(await readFile(join(root, "slot.txt"), "utf8")).toBe("replacement bytes longer");
  },
);

win("propagates native errors and closes pinned handles", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await fixture("ace-wfs-errors-", onTestFinished);
  await writeFile(join(root, "ok.txt"), "ok");

  const opened: number[] = [];
  const wfs = createWindowsFilesystem({
    openRoot: (path) => {
      const fd = core.openRoot(path);
      opened.push(fd);
      return fd;
    },
    openMetadataAt: (parent, name) => {
      const fd = core.openMetadataAt(parent, name);
      opened.push(fd);
      return fd;
    },
    statFd: (fd) => core.statFd(fd),
  });
  await expect(wfs.stat(join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(wfs.lstat(join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(wfs.lstat(join(root, "NUL"))).rejects.toMatchObject({ code: "EINVAL" });
  for (const path of ["C:relative", "\\absolute", "\\\\?\\C:\\file", "\\\\.\\C:\\file"]) {
    await expect(wfs.stat(path)).rejects.toMatchObject({ code: "EINVAL" });
    await expect(wfs.lstat(path)).rejects.toMatchObject({ code: "EINVAL" });
  }
  await expect(wfs.stat("\\\\ace-invalid\\share\\file")).rejects.toMatchObject({ code: "ENOTSUP" });
  for (const fd of opened) {
    expect(() => fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  }
  opened.length = 0;

  const throwing = createWindowsFilesystem({
    openRoot: (path) => {
      const fd = core.openRoot(path);
      opened.push(fd);
      return fd;
    },
    openMetadataAt: (parent, name) => {
      const fd = core.openMetadataAt(parent, name);
      opened.push(fd);
      return fd;
    },
    statFd: () => {
      throw Object.assign(new Error("stat boom"), { code: "EIO" });
    },
  });
  await expect(throwing.stat(join(root, "ok.txt"))).rejects.toMatchObject({ code: "EIO" });
  for (const fd of opened) {
    expect(() => fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  }

  const stealing = createWindowsFilesystem({
    openRoot: (path) => core.openRoot(path),
    openMetadataAt: (parent, name) => core.openMetadataAt(parent, name),
    statFd: (fd) => {
      closeSync(fd);
      return core.statFd(fd);
    },
  });
  await expect(stealing.stat(join(root, "ok.txt"))).rejects.toMatchObject({ code: "EBADF" });

  expect((await wfs.stat(join(root, "ok.txt"))).isFile()).toBe(true);
});
