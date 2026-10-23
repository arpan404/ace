import { closeSync, readSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { parseWindowsBinding } from "./descriptor-native.ts";
import { secureOwnerOnly } from "./windows-private-fixture.ts";

const require = createRequire(import.meta.url);
const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-private-metadata-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, core: parseWindowsBinding(require("../dist/windows-core.node")) };
}

win("repairs the held private file after its name is replaced", async ({ onTestFinished }) => {
  const { root, core } = await fixture(onTestFinished);
  const name = "secret-日本語-✓.txt";
  const moved = "held.txt";
  await writeFile(join(root, name), "original bytes");
  await secureOwnerOnly(join(root, name), "read");
  const parent = core.openRoot(root);
  try {
    const fd = core.openPrivateMetadataAt(parent, name);
    try {
      const identity = core.identityOf(fd);
      expect(() => core.checkPrivateFd(fd)).toThrow(expect.objectContaining({ code: "EACCES" }));
      await rename(join(root, name), join(root, moved));
      await writeFile(join(root, name), "decoy bytes");
      await secureOwnerOnly(join(root, name), "read");
      core.securePrivateFd(fd);
      expect(core.checkPrivateFd(fd)).toBeUndefined();
      expect(core.identityOf(fd)).toEqual(identity);
      expect(core.checkPrivateAt(parent, moved)).toBeUndefined();
      expect(() => core.checkPrivateAt(parent, name)).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      // Repairing metadata grants no data access to the already-open handle.
      expect(() => readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow();
      expect(core.identityOf(fd)).toEqual(identity);
      expect(await readFile(join(root, moved), "utf8")).toBe("original bytes");
      expect(await readFile(join(root, name), "utf8")).toBe("decoy bytes");
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent);
  }
});

win("refuses repair when a held private file gains a hard link", async ({ onTestFinished }) => {
  const { root, core } = await fixture(onTestFinished);
  await writeFile(join(root, "original.txt"), "linked bytes");
  await secureOwnerOnly(join(root, "original.txt"), "read");
  const parent = core.openRoot(root);
  try {
    const fd = core.openPrivateMetadataAt(parent, "original.txt");
    try {
      await link(join(root, "original.txt"), join(root, "alias.txt"));
      expect(() => core.securePrivateFd(fd)).toThrow(expect.objectContaining({ code: "EACCES" }));
      await rm(join(root, "alias.txt"));
      // Once the extra link is gone the checker still sees the original broad ACL.
      expect(() => core.checkPrivateFd(fd)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(await readFile(join(root, "original.txt"), "utf8")).toBe("linked bytes");
      core.securePrivateFd(fd);
      expect(core.checkPrivateFd(fd)).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent);
  }
});

win("refuses directory, junction and hardlinked private metadata", async ({ onTestFinished }) => {
  const { root, core } = await fixture(onTestFinished);
  await mkdir(join(root, "directory"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "keep.txt"), "outside bytes");
  await symlink(join(root, "outside"), join(root, "junction"), "junction");
  await writeFile(join(root, "linked.txt"), "linked bytes");
  await secureOwnerOnly(join(root, "linked.txt"), "read");
  await link(join(root, "linked.txt"), join(root, "alias.txt"));
  const parent = core.openRoot(root);
  try {
    for (const [name, code] of [
      ["directory", "EISDIR"],
      ["junction", "ELOOP"],
      ["linked.txt", "EACCES"],
      ["alias.txt", "EACCES"],
    ] as const)
      expect(() => core.openPrivateMetadataAt(parent, name)).toThrow(
        expect.objectContaining({ code }),
      );
    expect(() => core.securePrivateFd(parent)).toThrow(expect.objectContaining({ code: "EISDIR" }));
    const junction = core.openMetadataAt(parent, "junction");
    try {
      expect(() => core.securePrivateFd(junction)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
    } finally {
      closeSync(junction);
    }
    expect(await readFile(join(root, "outside", "keep.txt"), "utf8")).toBe("outside bytes");
  } finally {
    closeSync(parent);
  }
});

win("rejects unsafe private metadata names and closed descriptors", async ({ onTestFinished }) => {
  const { root, core } = await fixture(onTestFinished);
  await writeFile(join(root, "file.txt"), "bytes");
  await secureOwnerOnly(join(root, "file.txt"), "read");
  const parent = core.openRoot(root);
  try {
    for (const name of ["", ".", "..", "../escape", "file:stream", "NUL.txt"])
      expect(() => core.openPrivateMetadataAt(parent, name)).toThrow(
        expect.objectContaining({ code: "EINVAL" }),
      );
    expect(() => core.openPrivateMetadataAt(parent, "missing.txt")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    const closed = core.openPrivateMetadataAt(parent, "file.txt");
    closeSync(closed);
    expect(() => core.securePrivateFd(closed)).toThrow(expect.objectContaining({ code: "EBADF" }));
  } finally {
    closeSync(parent);
  }
  expect(() => core.openPrivateMetadataAt(parent, "file.txt")).toThrow(
    expect.objectContaining({ code: "EBADF" }),
  );
});
