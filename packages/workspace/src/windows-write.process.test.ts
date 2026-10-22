import { closeSync, fsyncSync, fstatSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  createFileAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  mkdirAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  openDirectoryAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  identityOf: z.function({
    input: [z.number().int()],
    output: z.object({ vol: z.string(), id: z.string() }),
  }),
});
const win = test.runIf(process.platform === "win32");

win(
  "creates a pinned Unicode directory and writes a file inside it",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wmkdir-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const parent = core.openRoot(root);
    try {
      core.mkdirAt(parent, "données-日本語");
      const directory = core.openDirectoryAt(parent, "données-日本語");
      try {
        const fd = core.createFileAt(directory, "nested.txt");
        try {
          writeSync(fd, "nested bytes");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } finally {
        closeSync(directory);
      }
      expect(await readFile(join(root, "données-日本語", "nested.txt"), "utf8")).toBe(
        "nested bytes",
      );
      for (const name of ["données-日本語", "existing.txt"]) {
        if (name === "existing.txt") await writeFile(join(root, name), "keep file");
        expect(() => core.mkdirAt(parent, name)).toThrowError(
          expect.objectContaining({ code: "EEXIST" }),
        );
      }
      expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep file");
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "writes and flushes an exclusively created Unicode file through Node",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wwrite-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const directory = core.openRoot(root);
    try {
      const fd = core.createFileAt(directory, "café-日本語.txt");
      const bytes = Buffer.from("Windows file editing: 😀é終\n".repeat(50));
      try {
        const identity = core.identityOf(fd);
        expect(writeSync(fd, bytes, 0, bytes.length, 0)).toBe(bytes.length);
        fsyncSync(fd);
        expect(fstatSync(fd).size).toBe(bytes.length);
        expect(core.identityOf(fd)).toEqual(identity);
      } finally {
        closeSync(fd);
      }
      expect(await readFile(join(root, "café-日本語.txt"))).toEqual(bytes);
    } finally {
      closeSync(directory);
    }
  },
);

win(
  "exclusive creation preserves existing files, directories and junction targets",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const base = await mkdtemp(join(tmpdir(), "ace-wwrite-collision-"));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "existing.txt"), "keep existing bytes");
    await writeFile(join(outside, "keep.txt"), "outside bytes");
    await symlink(outside, join(root, "junction"), "junction");
    const directory = core.openRoot(root);
    try {
      for (const name of ["existing.txt", "directory", "junction"])
        expect(() => core.createFileAt(directory, name)).toThrowError(
          expect.objectContaining({ code: "EEXIST" }),
        );
      expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep existing bytes");
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside bytes");
    } finally {
      closeSync(directory);
    }
  },
);

win("a replaced ancestor cannot redirect a pinned file creation", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const base = await mkdtemp(join(tmpdir(), "ace-wwrite-ancestor-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const pinned = join(base, "pinned");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  const directory = core.openRoot(root);
  try {
    await rename(root, pinned);
    await symlink(outside, root, "junction");
    const fd = core.createFileAt(directory, "new.txt");
    try {
      writeSync(fd, "stays in pinned directory");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    expect(await readFile(join(pinned, "new.txt"), "utf8")).toBe("stays in pinned directory");
    await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of ["../escape.txt", "NUL.txt", "file.txt:stream", "CON .txt"])
      expect(() => core.createFileAt(directory, name)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
  } finally {
    closeSync(directory);
  }
});
