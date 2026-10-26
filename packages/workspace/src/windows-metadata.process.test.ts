/**
 * Windows metadata slice behavior tests (statAt + names).
 *
 * Every test loads dist/windows-core.node and exercises real I/O through the
 * new handle-relative ops: statAt opens one validated component via
 * NtCreateFile(RootDirectory=parent) with no absolute join and no reparse
 * following; names enumerates via FileIdExtdDirectoryInfo on the
 * pinned handle with an explicit cap. No exports-exist tests. All tests skip
 * off Windows; compilation and execution are verified on a Windows VM
 * (pending native-VM parent); on other hosts this file must report skipped,
 * never red.
 */
import { closeSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const WindowsMeta = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  openDirectoryAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int(),
  }),
  openFileAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int(),
  }),
  identityOf: z.function({
    input: [z.number().int()],
    output: z.object({ vol: z.string(), id: z.string() }),
  }),
  statAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.object({
      vol: z.string(),
      id: z.string(),
      mode: z.number(),
      size: z.number(),
      mtimeMs: z.number(),
      attrs: z.number(),
    }),
  }),
  names: z.function({
    input: [z.number().int(), z.number().int()],
    output: z.array(z.string()).max(10_000),
  }),
});
type WindowsMeta = z.infer<typeof WindowsMeta>;

const RawMeta = z.object({
  openRoot: z.function({ input: [z.string()], output: z.unknown() }),
  openFileAt: z.function({ input: [z.unknown(), z.string()], output: z.unknown() }),
  statAt: z.function({ input: [z.unknown(), z.unknown()], output: z.unknown() }),
  names: z.function({ input: [z.unknown(), z.unknown()], output: z.unknown() }),
  identityOf: z.function({ input: [z.unknown()], output: z.unknown() }),
});
type RawMeta = z.infer<typeof RawMeta>;

function loadMeta(): WindowsMeta {
  return WindowsMeta.parse(require("../dist/windows-core.node"));
}

function loadRaw(): RawMeta {
  return RawMeta.parse(require("../dist/windows-core.node"));
}

const win = test.runIf(process.platform === "win32");

function expectCode(fn: () => unknown, code: string): Error {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) throw new Error(`Expected failure with code ${code}, got success`);
  expect("code" in error ? error.code : undefined).toBe(code);
  return error;
}

async function fixture(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

win("stats a file with lossless identity and real size", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-stat-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bytes = "hello metadata slice \u2713";
  const before = Date.now();
  await writeFile(join(root, "hello.txt"), bytes);
  const afterWrite = Date.now();
  const rootFd = core.openRoot(root);
  try {
    const info = core.statAt(rootFd, "hello.txt");
    expect(info.vol).toMatch(/^[0-9a-f]{16}$/);
    expect(info.id).toMatch(/^[0-9a-f]{32}$/);
    expect(info.size).toBe(Buffer.byteLength(bytes));
    expect(info.mtimeMs).toBeGreaterThan(0);
    expect(info.mtimeMs).toBeLessThanOrEqual(Date.now() + 5000);
    expect(info.mtimeMs).toBeGreaterThanOrEqual(before - 30_000);
    expect(info.mtimeMs).toBeLessThanOrEqual(afterWrite + 30_000);
    expect(info.mode & 0o170000).toBe(0o100000);
    const fileFd = core.openFileAt(rootFd, "hello.txt");
    try {
      expect(core.identityOf(fileFd)).toEqual({ vol: info.vol, id: info.id });
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(rootFd);
  }
});

win("reports directories and symlinks without following", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-kinds-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "target.txt"), "target bytes");
  await mkdir(join(root, "realdir"));
  let fileLink = true;
  try {
    await symlink(join(root, "target.txt"), join(root, "file-link"), "file");
  } catch {
    fileLink = false;
  }
  try {
    await symlink(join(root, "realdir"), join(root, "dir-junction"), "junction");
  } catch {
    throw new Error("Windows host cannot create junctions; reparse refusal untestable here");
  }
  const rootFd = core.openRoot(root);
  try {
    const dirInfo = core.statAt(rootFd, "realdir");
    expect(dirInfo.mode & 0o170000).toBe(0o040000);
    expect(dirInfo.vol).toMatch(/^[0-9a-f]{16}$/);
    const targetInfo = core.statAt(rootFd, "target.txt");
    expect(targetInfo.mode & 0o170000).toBe(0o100000);
    expect(targetInfo.vol).toBe(dirInfo.vol);
    if (fileLink) {
      const linkInfo = core.statAt(rootFd, "file-link");
      expect(linkInfo.mode & 0o170000).toBe(0o120000);
      expect(linkInfo.id).not.toBe(targetInfo.id);
    }
    const junctionInfo = core.statAt(rootFd, "dir-junction");
    expect(junctionInfo.mode & 0o170000).toBe(0o120000);
    expect(junctionInfo.id).not.toBe(dirInfo.id);
  } finally {
    closeSync(rootFd);
  }
});

win("rejects missing and invalid components at the stat boundary", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-statbad-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok");
  const rootFd = core.openRoot(root);
  try {
    expectCode(() => core.statAt(rootFd, "missing.txt"), "ENOENT");
    expectCode(() => core.statAt(rootFd, ".temp"), "ENOENT");
    for (const name of [
      "a:b",
      "a/b",
      "a\\b",
      "CON",
      "NUL.txt",
      "COM1",
      "trail.",
      "trail ",
      ".",
      "..",
      "",
      "?",
      "C:foo",
    ]) {
      expectCode(() => core.statAt(rootFd, name), "EINVAL");
    }
  } finally {
    closeSync(rootFd);
  }
});

win("keeps stat identity stable and changes it on replacement", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-replace-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "f.txt"), "v1");
  const rootFd = core.openRoot(root);
  try {
    const first = core.statAt(rootFd, "f.txt");
    expect(core.statAt(rootFd, "f.txt")).toEqual(first);
    await rm(join(root, "f.txt"));
    await writeFile(join(root, "f.txt"), "v2 with different bytes");
    const third = core.statAt(rootFd, "f.txt");
    expect(third.vol).toBe(first.vol);
    expect(third.id).not.toBe(first.id);
    expect(third.size).toBe(Buffer.byteLength("v2 with different bytes"));
  } finally {
    closeSync(rootFd);
  }
});

win(
  "enumerates entries with unicode preserved and without dot entries",
  async ({ onTestFinished }) => {
    const core = loadMeta();
    const root = await fixture("ace-wmeta-names-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fileName = "caf\u00e9-\u65e5\u672c\u8a9e-\u2713.txt";
    const dirName = "donn\u00e9es-\u65e5\u672c\u8a9e-\u2603";
    await writeFile(join(root, "plain.txt"), "plain");
    await writeFile(join(root, fileName), "unicode");
    await mkdir(join(root, dirName));
    await writeFile(join(root, dirName, "nested.txt"), "nested");
    const rootFd = core.openRoot(root);
    try {
      const entries = core.names(rootFd, 10_000).toSorted();
      expect(entries).toEqual([dirName, fileName, "plain.txt"].toSorted());
      expect(entries).not.toContain(".");
      expect(entries).not.toContain("..");
      const subFd = core.openDirectoryAt(rootFd, dirName);
      try {
        expect(core.names(subFd, 10_000)).toEqual(["nested.txt"]);
      } finally {
        closeSync(subFd);
      }
    } finally {
      closeSync(rootFd);
    }
  },
);

win("enforces explicit entry caps with E2BIG", async ({ onTestFinished }) => {
  const core = loadMeta();
  const raw = loadRaw();
  const root = await fixture("ace-wmeta-cap-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "b.txt"), "b");
  await writeFile(join(root, "c.txt"), "c");
  const rootFd = core.openRoot(root);
  try {
    expect(core.names(rootFd, 3).toSorted()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expectCode(() => core.names(rootFd, 2), "E2BIG");
    expectCode(() => core.names(rootFd, 1), "E2BIG");
    expectCode(() => core.names(rootFd, 0), "EINVAL");
    expectCode(() => raw.names(rootFd, 10_001), "EINVAL");
    expectCode(() => raw.names(rootFd, 1.5), "EINVAL");
    expectCode(() => raw.names(rootFd, Number.NaN), "EINVAL");
  } finally {
    closeSync(rootFd);
  }
});

win("roundtrips a pre-1970 mtime as negative", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-old-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "old.txt"), "old bytes");
  const expected = Date.UTC(1960, 4, 15, 12, 30, 45, 123);
  utimesSync(join(root, "old.txt"), new Date(expected), new Date(expected));
  const rootFd = core.openRoot(root);
  try {
    const info = core.statAt(rootFd, "old.txt");
    expect(info.mode & 0o170000).toBe(0o100000);
    expect(info.size).toBe(Buffer.byteLength("old bytes"));
    expect(info.mtimeMs).toBeLessThan(0);
    expect(Math.abs(info.mtimeMs - expected)).toBeLessThan(1);
  } finally {
    closeSync(rootFd);
  }
});

win(
  "restarts enumeration on repeat calls and lists empty directories",
  async ({ onTestFinished }) => {
    const core = loadMeta();
    const root = await fixture("ace-wmeta-repeat-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await mkdir(join(root, "empty"));
    const rootFd = core.openRoot(root);
    try {
      const first = core.names(rootFd, 10_000).toSorted();
      expect(first).toEqual(["a.txt", "b.txt", "empty"]);
      expect(core.names(rootFd, 10_000).toSorted()).toEqual(first);
      const emptyFd = core.openDirectoryAt(rootFd, "empty");
      try {
        expect(core.names(emptyFd, 10_000)).toEqual([]);
        expect(core.names(emptyFd, 1)).toEqual([]);
      } finally {
        closeSync(emptyFd);
      }
    } finally {
      closeSync(rootFd);
    }
  },
);

win("enumerates more entries than one batch with exact caps", async ({ onTestFinished }) => {
  const core = loadMeta();
  const root = await fixture("ace-wmeta-batch-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const count = 800;
  const wanted = new Set<string>();
  for (let i = 0; i < count; i++) {
    const name = `batch-${String(i).padStart(4, "0")}.txt`;
    wanted.add(name);
    await writeFile(join(root, name), "x");
  }
  const rootFd = core.openRoot(root);
  try {
    const first = core.names(rootFd, count);
    expect(first.length).toBe(count);
    expect(new Set(first)).toEqual(wanted);
    expect(core.names(rootFd, count)).toEqual(first);
    expectCode(() => core.names(rootFd, count - 1), "E2BIG");
  } finally {
    closeSync(rootFd);
  }
});

win("fails closed for non-directories and bad handles", async ({ onTestFinished }) => {
  const core = loadMeta();
  const raw = loadRaw();
  const root = await fixture("ace-wmeta-badfd-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok");
  const rootFd = core.openRoot(root);
  const fileFd = core.openFileAt(rootFd, "ok.txt");
  try {
    expectCode(() => core.names(fileFd, 10), "ENOTDIR");
  } finally {
    closeSync(fileFd);
  }
  closeSync(rootFd);
  expectCode(() => core.names(rootFd, 10), "EBADF");
  expectCode(() => core.statAt(rootFd, "ok.txt"), "EBADF");
  expectCode(() => raw.statAt(-1, "ok.txt"), "EINVAL");
  expectCode(() => raw.names(-1, 10), "EINVAL");
  expectCode(() => raw.statAt(1.5, "ok.txt"), "EINVAL");
  expectCode(() => raw.names(1.5, 10), "EINVAL");
  const freshFd = core.openRoot(root);
  try {
    expect(core.statAt(freshFd, "ok.txt").size).toBe(2);
    expect(core.names(freshFd, 10)).toEqual(["ok.txt"]);
  } finally {
    closeSync(freshFd);
  }
});
