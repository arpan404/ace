/**
 * Windows handle-core behavior tests (W04 first cut).
 *
 * Every test loads dist/windows-core.node and exercises real I/O through the
 * bridged numeric fds (Node fstat/read/close on addon-returned fds): no
 * exports-exist tests. All tests skip off Windows; the native module is only
 * required inside test bodies so collection stays green on macOS/Linux.
 * Compilation and execution are verified on a Windows VM (pending native-VM
 * parent); on other hosts this file must report skipped, never red.
 */
import { closeSync, fstatSync, readSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const WindowsCore = z.object({
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
});
type WindowsCore = z.infer<typeof WindowsCore>;

const RawWindowsCore = z.object({
  openRoot: z.function({ input: [z.string()], output: z.unknown() }),
  openDirectoryAt: z.function({ input: [z.unknown(), z.string()], output: z.unknown() }),
  openFileAt: z.function({ input: [z.unknown(), z.string()], output: z.unknown() }),
  identityOf: z.function({ input: [z.unknown()], output: z.unknown() }),
});
type RawWindowsCore = z.infer<typeof RawWindowsCore>;

function loadRawCore(): RawWindowsCore {
  return RawWindowsCore.parse(require("../dist/windows-core.node"));
}

function loadCore(): WindowsCore {
  return WindowsCore.parse(require("../dist/windows-core.node"));
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

function readAll(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64);
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fixture(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

win("reads file bytes through a no-follow fd bridged for Node fs", async ({ onTestFinished }) => {
  const core = loadCore();
  const root = await fixture("ace-wincore-read-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "hello.txt"), "hello windows-core");
  const rootFd = core.openRoot(root);
  try {
    const fileFd = core.openFileAt(rootFd, "hello.txt");
    try {
      expect(fstatSync(fileFd).isFile()).toBe(true);
      expect(readAll(fileFd)).toBe("hello windows-core");
      const first = core.identityOf(fileFd);
      expect(first.vol).toMatch(/^[0-9a-f]{16}$/);
      expect(first.id).toMatch(/^[0-9a-f]{32}$/);
      expect(core.identityOf(fileFd)).toEqual(first);
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(rootFd);
  }
});

win("opens directories through a pinned parent fd", async ({ onTestFinished }) => {
  const core = loadCore();
  const root = await fixture("ace-wincore-dir-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "nested.txt"), "nested");
  await writeFile(join(root, "top.txt"), "top");
  const rootFd = core.openRoot(root);
  try {
    const subFd = core.openDirectoryAt(rootFd, "sub");
    try {
      expect(fstatSync(subFd).isDirectory()).toBe(true);
      const nestedFd = core.openFileAt(subFd, "nested.txt");
      try {
        expect(readAll(nestedFd)).toBe("nested");
      } finally {
        closeSync(nestedFd);
      }
    } finally {
      closeSync(subFd);
    }
    // Type gates fail closed: files are not directories and vice versa.
    expectCode(() => core.openDirectoryAt(rootFd, "top.txt"), "ENOTDIR");
    expectCode(() => core.openFileAt(rootFd, "sub"), "EISDIR");
    // The walk never creates and never descends through a file.
    expectCode(() => core.openRoot(join(root, "nope")), "ENOENT");
    expectCode(() => core.openRoot(join(root, "top.txt", "x")), "ENOTDIR");
  } finally {
    closeSync(rootFd);
  }
});

win(
  "rejects ADS, reserved, and trailing-dot components at the boundary",
  async ({ onTestFinished }) => {
    const core = loadCore();
    const root = await fixture("ace-wincore-names-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const rootFd = core.openRoot(root);
    try {
      const bad = [
        "a:b",
        "stream.txt:stream",
        "a/b",
        "a\\b",
        "CON",
        "con",
        "NUL.txt",
        "COM1",
        "lpt9",
        "AUX.log",
        "trail.",
        "trail ",
        "...",
        ".",
        "..",
        "",
        "?",
        "a*b",
        'quote"name',
        "C:foo",
      ];
      for (const name of bad) {
        expectCode(() => core.openFileAt(rootFd, name), "EINVAL");
        expectCode(() => core.openDirectoryAt(rootFd, name), "EINVAL");
      }
      // Leading-dot names are lexically valid; a missing one fails at open.
      expectCode(() => core.openFileAt(rootFd, ".temp"), "ENOENT");
    } finally {
      closeSync(rootFd);
    }
  },
);

win(
  "refuses symlink and junction children instead of following them",
  async ({ onTestFinished }) => {
    const core = loadCore();
    const root = await fixture("ace-wincore-link-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "target.txt"), "target");
    await mkdir(join(root, "realdir"));
    let fileLink = true;
    try {
      await symlink(join(root, "target.txt"), join(root, "file-link"), "file");
    } catch {
      fileLink = false;
    }
    // Junctions need no privilege; without one the host cannot test escapes.
    try {
      await symlink(join(root, "realdir"), join(root, "dir-junction"), "junction");
    } catch {
      throw new Error("Windows host cannot create junctions; reparse refusal untestable here");
    }
    const rootFd = core.openRoot(root);
    try {
      if (fileLink) {
        expectCode(() => core.openFileAt(rootFd, "file-link"), "ELOOP");
        expectCode(() => core.openDirectoryAt(rootFd, "file-link"), "ELOOP");
      }
      expectCode(() => core.openDirectoryAt(rootFd, "dir-junction"), "ELOOP");
      expectCode(() => core.openFileAt(rootFd, "dir-junction"), "ELOOP");
    } finally {
      closeSync(rootFd);
    }
  },
);

win(
  "keeps identity stable across opens and changes it on replacement",
  async ({ onTestFinished }) => {
    const core = loadCore();
    const root = await fixture("ace-wincore-ident-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "f.txt"), "v1");
    const rootFd = core.openRoot(root);
    try {
      const firstFd = core.openFileAt(rootFd, "f.txt");
      let first: { vol: string; id: string };
      try {
        first = core.identityOf(firstFd);
      } finally {
        closeSync(firstFd);
      }
      const secondFd = core.openFileAt(rootFd, "f.txt");
      try {
        expect(core.identityOf(secondFd)).toEqual(first);
      } finally {
        closeSync(secondFd);
      }
      // Delete + recreate assigns a new FileId (sequence advances even if the
      // MFT record is reused), so replacement must not alias the old identity.
      await rm(join(root, "f.txt"));
      await writeFile(join(root, "f.txt"), "v2 with different bytes");
      const thirdFd = core.openFileAt(rootFd, "f.txt");
      try {
        const third = core.identityOf(thirdFd);
        expect(third.vol).toBe(first.vol);
        expect(third.id).not.toBe(first.id);
        expect(readAll(thirdFd)).toBe("v2 with different bytes");
      } finally {
        closeSync(thirdFd);
      }
    } finally {
      closeSync(rootFd);
    }
  },
);

win(
  "an ancestor swapped for a junction breaks the walk instead of redirecting it",
  async ({ onTestFinished }) => {
    const core = loadCore();
    const root = await fixture("ace-wincore-race-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "gate", "real"), { recursive: true });
    await writeFile(join(root, "gate", "real", "deep.txt"), "deep");
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "deep.txt"), "impostor");
    const pinned = core.openRoot(join(root, "gate", "real"));
    let pinnedIdentity: { vol: string; id: string };
    try {
      pinnedIdentity = core.identityOf(pinned);
      await rename(join(root, "gate", "real"), join(root, "gate", "moved"));
      await symlink(join(root, "elsewhere"), join(root, "gate", "real"), "junction");
      // The walk must refuse the junction, not resolve into "elsewhere".
      expectCode(() => core.openRoot(join(root, "gate", "real")), "ELOOP");
      expectCode(() => core.openRoot(join(root, "gate", "real", "deep.txt")), "ELOOP");
      // The handle pinned before the swap still names the moved directory.
      expect(core.identityOf(pinned)).toEqual(pinnedIdentity);
      const moved = core.openRoot(join(root, "gate", "moved"));
      try {
        expect(core.identityOf(moved)).toEqual(pinnedIdentity);
      } finally {
        closeSync(moved);
      }
    } finally {
      closeSync(pinned);
    }
  },
);

win("refuses UNC roots explicitly in this first cut", () => {
  const core = loadCore();
  const error = expectCode(() => core.openRoot("\\\\server\\share\\dir"), "ENOTSUP");
  expect(error.message).toMatch(/UNC/);
  expectCode(() => core.openRoot("\\\\?\\C:\\x"), "EINVAL");
});

win("rejects malformed fds with EINVAL without crashing", async ({ onTestFinished }) => {
  const core = loadCore();
  const raw = loadRawCore();
  const root = await fixture("ace-wincore-badfd-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok");
  const rootFd = core.openRoot(root);
  try {
    for (const bad of [-1, 2147483648, 4294967296]) {
      expectCode(() => core.openFileAt(bad, "ok.txt"), "EINVAL");
      expectCode(() => core.openDirectoryAt(bad, "ok.txt"), "EINVAL");
      expectCode(() => core.identityOf(bad), "EINVAL");
    }
    const malformed: Array<unknown> = [1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"];
    for (const bad of malformed) {
      expectCode(() => raw.openFileAt(bad, "ok.txt"), "EINVAL");
      expectCode(() => raw.openDirectoryAt(bad, "ok.txt"), "EINVAL");
      expectCode(() => raw.identityOf(bad), "EINVAL");
    }
    // The boundary stays alive for a valid fd after malformed attempts.
    const fileFd = core.openFileAt(rootFd, "ok.txt");
    try {
      expect(readAll(fileFd)).toBe("ok");
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(rootFd);
  }
});

win("fails closed fds with EBADF without crashing", async ({ onTestFinished }) => {
  const core = loadCore();
  const root = await fixture("ace-wincore-closedfd-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok");
  const rootFd = core.openRoot(root);
  closeSync(rootFd);
  expectCode(() => core.openFileAt(rootFd, "ok.txt"), "EBADF");
  expectCode(() => core.openDirectoryAt(rootFd, "ok.txt"), "EBADF");
  expectCode(() => core.identityOf(rootFd), "EBADF");
  // In-range but never-opened fds also fail closed without crashing.
  expectCode(() => core.openFileAt(999999, "ok.txt"), "EBADF");
  expectCode(() => core.identityOf(999999), "EBADF");
  expectCode(() => core.openFileAt(2147483647, "ok.txt"), "EBADF");
  expectCode(() => core.identityOf(2147483647), "EBADF");
  // A fresh valid root still reads after the EBADF failures.
  const freshFd = core.openRoot(root);
  try {
    const fileFd = core.openFileAt(freshFd, "ok.txt");
    try {
      expect(readAll(fileFd)).toBe("ok");
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(freshFd);
  }
});

win("refuses drive-relative and bare-absolute roots", () => {
  const core = loadCore();
  expectCode(() => core.openRoot("C:foo"), "EINVAL");
  expectCode(() => core.openRoot("C:"), "EINVAL");
  expectCode(() => core.openRoot("\\foo"), "EINVAL");
  expectCode(() => core.openRoot("/foo"), "EINVAL");
});

win("rejects reserved aliases with spaces before the dot", async ({ onTestFinished }) => {
  const core = loadCore();
  const root = await fixture("ace-wincore-alias-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok");
  const rootFd = core.openRoot(root);
  try {
    const aliases = [
      "CON .txt",
      "con .txt",
      "COM1 .log",
      "com9 .doc",
      "AUX .log",
      "NUL .tar.gz",
      "CON   .txt",
    ];
    for (const name of aliases) {
      expectCode(() => core.openFileAt(rootFd, name), "EINVAL");
      expectCode(() => core.openDirectoryAt(rootFd, name), "EINVAL");
    }
    const fileFd = core.openFileAt(rootFd, "ok.txt");
    try {
      expect(readAll(fileFd)).toBe("ok");
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(rootFd);
  }
});

win("roundtrips unicode file and directory names through the root", async ({ onTestFinished }) => {
  const core = loadCore();
  const root = await fixture("ace-wincore-unicode-");
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const fileName = "caf\u00e9-\u65e5\u672c\u8a9e-\u2713.txt";
  const dirName = "donn\u00e9es-\u65e5\u672c\u8a9e-\u2603";
  const nestedName = "nested-\u2713.txt";
  await mkdir(join(root, dirName));
  await writeFile(join(root, fileName), "unicode file bytes \u2713 \u65e5\u672c");
  await writeFile(join(root, dirName, nestedName), "unicode nested bytes \u2603 \u65e5\u672c");
  const rootFd = core.openRoot(root);
  try {
    const fileFd = core.openFileAt(rootFd, fileName);
    try {
      expect(fstatSync(fileFd).isFile()).toBe(true);
      expect(readAll(fileFd)).toBe("unicode file bytes \u2713 \u65e5\u672c");
    } finally {
      closeSync(fileFd);
    }
    const subFd = core.openDirectoryAt(rootFd, dirName);
    try {
      expect(fstatSync(subFd).isDirectory()).toBe(true);
      const nestedFd = core.openFileAt(subFd, nestedName);
      try {
        expect(readAll(nestedFd)).toBe("unicode nested bytes \u2603 \u65e5\u672c");
      } finally {
        closeSync(nestedFd);
      }
    } finally {
      closeSync(subFd);
    }
    // The unicode directory itself opens as a root and reads its child.
    const dirRootFd = core.openRoot(join(root, dirName));
    try {
      const nestedFd = core.openFileAt(dirRootFd, nestedName);
      try {
        expect(readAll(nestedFd)).toBe("unicode nested bytes \u2603 \u65e5\u672c");
      } finally {
        closeSync(nestedFd);
      }
    } finally {
      closeSync(dirRootFd);
    }
  } finally {
    closeSync(rootFd);
  }
});
