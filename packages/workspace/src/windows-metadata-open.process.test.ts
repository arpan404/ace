import { closeSync, readFileSync, readSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { z } from "zod";
import { Descriptor, windowsDescriptorStats } from "./descriptor.ts";
import { Win32FileIdentitySchema, sameFile } from "./file-identity.ts";

const require = createRequire(import.meta.url);
const nativeIdentity = Win32FileIdentitySchema.omit({ kind: true });
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
  openMetadataAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int().nonnegative(),
  }),
  identityOf: z.function({ input: [z.number().int()], output: nativeIdentity }),
  statAt: z.function({ input: [z.number().int(), z.string()], output: nativeIdentity }),
  checkPrivateFd: z.function({ input: [z.number().int()], output: z.void() }),
});
const RawBinding = z.object({
  openMetadataAt: z.function({ input: [z.unknown(), z.unknown()], output: z.unknown() }),
});
const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-win-metadata-open-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const addon: unknown = require("../dist/windows-core.node");
  const core = Binding.parse(addon);
  const stats = windowsDescriptorStats(core.identityOf);
  return {
    root,
    core,
    raw: RawBinding.parse(addon),
    open: (parent: number, name: string) =>
      new Descriptor(core.openMetadataAt(parent, name), stats),
  };
}

win(
  "metadata descriptors query files and directories without granting content access",
  async ({ onTestFinished }) => {
    const { root, core, open } = await fixture(onTestFinished);
    const bytes = Buffer.from("metadata only 日本語 ✓");
    await writeFile(join(root, "日本語.txt"), bytes);
    await mkdir(join(root, "directory"));
    const parent = core.openRoot(root);
    try {
      for (const name of ["日本語.txt", "directory"]) {
        const subject = open(parent, name);
        try {
          const info = await subject.stat();
          expect(info.identity).toEqual({ kind: "win32", ...core.statAt(parent, name) });
          expect(subject.statSync().identity).toEqual(info.identity);
          expect(info.isDirectory()).toBe(name === "directory");
          expect(info.isFile()).toBe(name === "日本語.txt");
          if (info.isFile()) {
            expect(info.size).toBe(bytes.length);
            expect(() => readSync(subject.fd, Buffer.alloc(1), 0, 1, 0)).toThrow();
            expect(() => writeSync(subject.fd, Buffer.from("!"), 0, 1, 0)).toThrow();
            expect((await subject.stat()).identity).toEqual(info.identity);
          }
        } finally {
          await subject.close();
        }
      }
      expect(readFileSync(join(root, "日本語.txt"))).toEqual(bytes);
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "metadata descriptors and parent traversal stay pinned after pathname replacement",
  async ({ onTestFinished }) => {
    const { root, core, open } = await fixture(onTestFinished);
    await mkdir(join(root, "scope"));
    await writeFile(join(root, "scope", "slot.txt"), "original");
    const parent = core.openRoot(join(root, "scope"));
    try {
      const held = open(parent, "slot.txt");
      try {
        const identity = held.statSync().identity;
        await rename(join(root, "scope"), join(root, "moved"));
        await mkdir(join(root, "scope"));
        await writeFile(join(root, "scope", "slot.txt"), "decoy");
        const original = open(parent, "slot.txt");
        try {
          expect(sameFile((await original.stat()).identity, identity)).toBe(true);
        } finally {
          await original.close();
        }
        await rename(join(root, "moved", "slot.txt"), join(root, "moved", "old.txt"));
        await writeFile(join(root, "moved", "slot.txt"), "replacement");
        const replacement = open(parent, "slot.txt");
        try {
          expect(sameFile((await replacement.stat()).identity, identity)).toBe(false);
        } finally {
          await replacement.close();
        }
        expect(sameFile((await held.stat()).identity, identity)).toBe(true);
        expect(held.statSync().size).toBe(Buffer.byteLength("original"));
        expect(readFileSync(join(root, "scope", "slot.txt"), "utf8")).toBe("decoy");
      } finally {
        await held.close();
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "a metadata junction descriptor identifies the link and cannot become a traversal parent",
  async ({ onTestFinished }) => {
    const { root, core, open } = await fixture(onTestFinished);
    await mkdir(join(root, "outside"));
    await mkdir(join(root, "scope"));
    await writeFile(join(root, "outside", "sentinel.txt"), "outside bytes");
    await symlink(join(root, "outside"), join(root, "scope", "junction"), "junction");
    const parent = core.openRoot(join(root, "scope"));
    const target = core.openRoot(join(root, "outside"));
    try {
      const link = open(parent, "junction");
      try {
        const info = await link.stat();
        expect(info.identity).toEqual({ kind: "win32", ...core.statAt(parent, "junction") });
        expect(info.isSymbolicLink()).toBe(true);
        expect(sameFile(info.identity, { kind: "win32", ...core.identityOf(target) })).toBe(false);
        expect(() => core.checkPrivateFd(link.fd)).toThrowError(
          expect.objectContaining({ code: "ELOOP" }),
        );
        expect(() => core.openMetadataAt(link.fd, "sentinel.txt")).toThrowError(
          expect.objectContaining({ code: "ELOOP" }),
        );
      } finally {
        await link.close();
      }
      expect(readFileSync(join(root, "outside", "sentinel.txt"), "utf8")).toBe("outside bytes");
    } finally {
      closeSync(target);
      closeSync(parent);
    }
  },
);

win(
  "metadata opens reject aliases, invalid descriptors and non-directory parents",
  async ({ onTestFinished }) => {
    const { root, core, raw, open } = await fixture(onTestFinished);
    await writeFile(join(root, "file.txt"), "intact");
    const parent = core.openRoot(root);
    try {
      for (const name of [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "file.txt:stream",
        "NUL",
        "trail.",
        "nul\0tail",
      ]) {
        expect(() => raw.openMetadataAt(parent, name)).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
      for (const fd of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
        expect(() => raw.openMetadataAt(fd, "file.txt")).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
      expect(() => core.openMetadataAt(parent, "missing.txt")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
      const file = open(parent, "file.txt");
      try {
        expect(() => core.openMetadataAt(file.fd, "child")).toThrowError(
          expect.objectContaining({ code: "ENOTDIR" }),
        );
      } finally {
        await file.close();
      }
      expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("intact");
    } finally {
      closeSync(parent);
    }
    expect(() => core.openMetadataAt(parent, "file.txt")).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
  },
);
