import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { z } from "zod";
import { broadenParent } from "./windows-private-fixture.ts";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  createPrivateFileAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int(),
  }),
  checkPrivateFd: z.function({ input: [z.number().int()], output: z.void() }),
  checkPrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
});
const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-private-create-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, core: Binding.parse(require("../dist/windows-core.node")) };
}

win(
  "private creation overrides a parent's public inheritance before returning writable data",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    await broadenParent(root);
    await writeFile(join(root, "inherited.txt"), "public control");
    const parent = core.openRoot(root);
    try {
      expect(() => core.checkPrivateAt(parent, "inherited.txt")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      const name = "privé-日本語-✓.txt";
      const fd = core.createPrivateFileAt(parent, name);
      try {
        expect(core.checkPrivateFd(fd)).toBeUndefined();
        const bytes = Buffer.from("secret 日本語 ✓");
        expect(writeSync(fd, bytes)).toBe(bytes.length);
        expect(readFileSync(join(root, name))).toEqual(bytes);
        expect(core.checkPrivateAt(parent, name)).toBeUndefined();
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(join(root, "inherited.txt"), "utf8")).toBe("public control");
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "private creation refuses existing files, directories and junctions without changing them",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    await broadenParent(root);
    await writeFile(join(root, "existing.txt"), "keep these bytes");
    await mkdir(join(root, "directory"));
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "sentinel.txt"), "outside survives");
    await symlink(join(root, "outside"), join(root, "junction"), "junction");
    const parent = core.openRoot(root);
    try {
      expect(() => core.checkPrivateAt(parent, "existing.txt")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      for (const name of ["existing.txt", "directory", "junction"])
        expect(() => core.createPrivateFileAt(parent, name)).toThrow(
          expect.objectContaining({ code: "EEXIST" }),
        );
      expect(() => core.checkPrivateAt(parent, "existing.txt")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("keep these bytes");
      expect(readFileSync(join(root, "outside", "sentinel.txt"), "utf8")).toBe("outside survives");
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "private creation stays in its pinned parent after an ancestor is replaced",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    const slot = join(root, "slot");
    const moved = join(root, "moved");
    await mkdir(slot);
    const parent = core.openRoot(slot);
    try {
      await rename(slot, moved);
      await mkdir(slot);
      await writeFile(join(slot, "secret.txt"), "decoy remains public");
      const fd = core.createPrivateFileAt(parent, "secret.txt");
      try {
        expect(core.checkPrivateFd(fd)).toBeUndefined();
        writeSync(fd, "pinned private bytes");
        expect(readFileSync(join(moved, "secret.txt"), "utf8")).toBe("pinned private bytes");
        expect(readFileSync(join(slot, "secret.txt"), "utf8")).toBe("decoy remains public");
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "private creation rejects unsafe names and invalid parent descriptors",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    const parent = core.openRoot(root);
    try {
      for (const name of ["", ".", "..", "../escape", "file:stream", "nul.txt"])
        expect(() => core.createPrivateFileAt(parent, name)).toThrow(
          expect.objectContaining({ code: "EINVAL" }),
        );
    } finally {
      closeSync(parent);
    }
    expect(() => core.createPrivateFileAt(parent, "closed.txt")).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => core.createPrivateFileAt(-1, "negative.txt")).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    await writeFile(join(root, "ordinary.txt"), "ordinary parent");
    const file = openSync(join(root, "ordinary.txt"), "r");
    try {
      expect(() => core.createPrivateFileAt(file, "child.txt")).toThrow(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
      expect(readFileSync(file, "utf8")).toBe("ordinary parent");
    } finally {
      closeSync(file);
    }
  },
);
