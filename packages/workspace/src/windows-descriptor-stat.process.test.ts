import { closeSync, readFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { z } from "zod";
import { Descriptor, windowsDescriptorStats } from "./descriptor.ts";
import { FileIdentitySchema, sameFile } from "./file-identity.ts";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  openFileAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  createPrivateFileAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int(),
  }),
  identityOf: z.function({ input: [z.number().int()], output: z.unknown() }),
});
const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-win-descriptor-stat-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const core = Binding.parse(require("../dist/windows-core.node"));
  return { root, core, stats: windowsDescriptorStats(core.identityOf) };
}

win(
  "descriptor stats preserve native Windows identity and serializable file metadata",
  async ({ onTestFinished }) => {
    const { root, core, stats } = await fixture(onTestFinished);
    const parent = core.openRoot(root);
    try {
      const file = new Descriptor(core.createPrivateFileAt(parent, "日本語-✓.txt"), stats);
      try {
        const bytes = Buffer.from("descriptor bytes 日本語 ✓");
        await file.write(bytes);
        const expected = z
          .object({ vol: z.string(), id: z.string() })
          .parse(core.identityOf(file.fd));
        const sync = file.statSync();
        const async = await file.stat();
        expect(sync.identity).toEqual({ kind: "win32", ...expected });
        expect(async.identity).toEqual(sync.identity);
        expect(sameFile(sync.identity, async.identity)).toBe(true);
        for (const info of [sync, async]) {
          expect(info.isFile()).toBe(true);
          expect(info.size).toBe(bytes.length);
          expect(typeof info.dev).toBe("number");
          expect(typeof info.ino).toBe("number");
          expect(info.mtimeMs).toBeGreaterThan(0);
          const serialized = z
            .object({ identity: FileIdentitySchema, size: z.number() })
            .parse(JSON.parse(JSON.stringify(info)));
          expect(serialized.identity).toEqual(sync.identity);
          expect(serialized.size).toBe(bytes.length);
        }
        expect(readFileSync(join(root, "日本語-✓.txt"))).toEqual(bytes);
      } finally {
        await file.close();
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "descriptor stats stay on the opened file when its name is replaced",
  async ({ onTestFinished }) => {
    const { root, core, stats } = await fixture(onTestFinished);
    const parent = core.openRoot(root);
    try {
      const file = new Descriptor(core.createPrivateFileAt(parent, "slot.txt"), stats);
      try {
        await file.write(Buffer.from("original bytes"));
        const identity = file.statSync().identity;
        await rename(join(root, "slot.txt"), join(root, "moved.txt"));
        await writeFile(join(root, "slot.txt"), "replacement bytes");
        expect(sameFile((await file.stat()).identity, identity)).toBe(true);
        expect(sameFile(file.statSync().identity, identity)).toBe(true);
        const replacement = new Descriptor(core.openFileAt(parent, "slot.txt"), stats);
        try {
          expect(sameFile((await replacement.stat()).identity, identity)).toBe(false);
        } finally {
          await replacement.close();
        }
        const bytes = Buffer.alloc(32);
        const read = await file.read(bytes, 0, bytes.length, 0);
        expect(bytes.subarray(0, read.bytesRead).toString()).toBe("original bytes");
        expect(readFileSync(join(root, "slot.txt"), "utf8")).toBe("replacement bytes");
      } finally {
        await file.close();
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "directory descriptor stats retain their Windows identity and directory behavior",
  async ({ onTestFinished }) => {
    const { root, core, stats } = await fixture(onTestFinished);
    const directory = new Descriptor(core.openRoot(root), stats);
    try {
      const sync = directory.statSync();
      const async = await directory.stat();
      expect(sync.isDirectory()).toBe(true);
      expect(async.isDirectory()).toBe(true);
      expect(async.isFile()).toBe(false);
      expect(sync.identity.kind).toBe("win32");
      expect(sameFile(sync.identity, async.identity)).toBe(true);
    } finally {
      await directory.close();
    }
  },
);

win(
  "malformed native identity rejects synchronous and asynchronous descriptor stats",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    const parent = core.openRoot(root);
    try {
      const stats = windowsDescriptorStats(() => ({ vol: "invalid", id: "0".repeat(32) }));
      const file = new Descriptor(core.createPrivateFileAt(parent, "invalid-id.txt"), stats);
      try {
        expect(() => file.statSync()).toThrow();
        await expect(file.stat()).rejects.toThrow();
        // A refused observation leaves the caller's descriptor alive and writable.
        await file.write(Buffer.from("still owned"));
        expect(readFileSync(join(root, "invalid-id.txt"), "utf8")).toBe("still owned");
      } finally {
        await file.close();
      }
    } finally {
      closeSync(parent);
    }
  },
);
