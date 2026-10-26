import { closeSync, fsyncSync, writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  createFileAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  openFileAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  renameAt: z.function({ input: [z.number().int(), z.string(), z.string()], output: z.void() }),
  renameExclusiveAt: z.function({
    input: [z.number().int(), z.string(), z.string()],
    output: z.void(),
  }),
  identityOf: z.function({
    input: [z.number().int()],
    output: z.object({ vol: z.string(), id: z.string() }),
  }),
});
const win = test.runIf(process.platform === "win32");

win(
  "publishes flushed bytes by replacement while preserving the staged identity",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wrename-publish-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "café-日本語.txt"), "old bytes");
    const parent = core.openRoot(root);
    try {
      const staged = core.createFileAt(parent, "pending.txt");
      try {
        writeSync(staged, "new flushed bytes 😀");
        fsyncSync(staged);
        const identity = core.identityOf(staged);
        core.renameAt(parent, "pending.txt", "café-日本語.txt");
        const published = core.openFileAt(parent, "café-日本語.txt");
        try {
          expect(core.identityOf(published)).toEqual(identity);
        } finally {
          closeSync(published);
        }
        expect(await readFile(join(root, "café-日本語.txt"), "utf8")).toBe("new flushed bytes 😀");
        await expect(lstat(join(root, "pending.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        closeSync(staged);
      }
    } finally {
      closeSync(parent);
    }
  },
);

win("exclusive rename preserves existing files and directories", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await mkdtemp(join(tmpdir(), "ace-wrename-exclusive-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "source bytes");
  await writeFile(join(root, "existing.txt"), "keep bytes");
  await mkdir(join(root, "directory"));
  const parent = core.openRoot(root);
  try {
    expect(() => core.renameExclusiveAt(parent, "source.txt", "existing.txt")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(() => core.renameExclusiveAt(parent, "source.txt", "directory")).toThrow();
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source bytes");
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("keep bytes");
    expect((await lstat(join(root, "directory"))).isDirectory()).toBe(true);
    core.renameExclusiveAt(parent, "source.txt", "moved.txt");
    expect(await readFile(join(root, "moved.txt"), "utf8")).toBe("source bytes");
    await expect(lstat(join(root, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const invalid of ["..", "../escape", "NUL.txt", "file:stream", "trailing."])
      for (const move of [core.renameAt, core.renameExclusiveAt]) {
        expect(() => move(parent, invalid, "target.txt")).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
        expect(() => move(parent, "moved.txt", invalid)).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
    expect(() => core.renameAt(parent, "missing.txt", "target.txt")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(await readFile(join(root, "moved.txt"), "utf8")).toBe("source bytes");
  } finally {
    closeSync(parent);
  }
});

win(
  "rename stays pinned after ancestor replacement and moves a junction itself",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const base = await mkdtemp(join(tmpdir(), "ace-wrename-pinned-"));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "root");
    const pinned = join(base, "pinned");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "source.txt"), "inside bytes");
    await writeFile(join(outside, "source.txt"), "outside source");
    await writeFile(join(outside, "target.txt"), "outside target");
    await symlink(outside, join(root, "junction"), "junction");
    const parent = core.openRoot(root);
    try {
      await rename(root, pinned);
      await symlink(outside, root, "junction");
      core.renameAt(parent, "source.txt", "target.txt");
      expect(await readFile(join(pinned, "target.txt"), "utf8")).toBe("inside bytes");
      core.renameExclusiveAt(parent, "junction", "moved-junction");
      expect((await lstat(join(pinned, "moved-junction"))).isSymbolicLink()).toBe(true);
      await expect(lstat(join(pinned, "junction"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(outside, "source.txt"), "utf8")).toBe("outside source");
      expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside target");
    } finally {
      closeSync(parent);
    }
  },
);
