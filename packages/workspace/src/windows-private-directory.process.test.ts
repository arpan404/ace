import { execFile } from "node:child_process";
import { closeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type TestContext } from "vitest";
import { parseWindowsBinding } from "./descriptor-native.ts";
import { PinnedDirectory } from "./index.ts";
import { broadenParent, systemPowerShell } from "./windows-private-fixture.ts";

const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = await mkdtemp(join(tmpdir(), "ace-private-directory-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, core: parseWindowsBinding(require("../dist/windows-core.node")) };
}

win(
  "private directory creation excludes public inheritance for itself and new children",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    await broadenParent(root);
    const parent = PinnedDirectory.atBoundary(root);
    try {
      const child = parent.mkdirPrivate("privé-日本語");
      try {
        child.checkPrivate();
        const identity = core.identityOf(child.fd);
        const path = join(root, "privé-日本語", "database.sqlite");
        await writeFile(path, "private child bytes");
        // Independent .NET observation of effective inherited permissions, as
        // used by SQLite and other ordinary file creators within the home.
        const script = [
          "$ErrorActionPreference='Stop'",
          "$a=[System.IO.File]::GetAccessControl($env:ACE_PRIVATE_TARGET)",
          "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
          "$r=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
          "if($r.Count -ne 1){throw 'unexpected ACE count'}",
          "$e=$r[0]",
          "if($e.IdentityReference.Value -ne $m.Value){throw 'unexpected SID'}",
          "if($e.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow){throw 'not allowed'}",
          "$full=[System.Security.AccessControl.FileSystemRights]::FullControl",
          "if(($e.FileSystemRights -band $full) -ne $full){throw 'missing rights'}",
          "if(-not $e.IsInherited){throw 'not inherited'}",
          "[Console]::Out.Write('owner-only-inherited')",
        ].join(";");
        const result = await runFile(
          systemPowerShell(),
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            env: { ...process.env, ACE_PRIVATE_TARGET: path },
          },
        );
        expect(result.stdout).toBe("owner-only-inherited");
        expect(core.identityOf(child.fd)).toEqual(identity);
        expect(await readFile(path, "utf8")).toBe("private child bytes");
      } finally {
        child.closeSync();
      }
      const observed = core.openDirectoryAt(parent.fd, "privé-日本語");
      try {
        // Ordinary directory opens need not carry READ_CONTROL; the checker
        // acquires security-query rights on the same object, without a name.
        expect(core.checkPrivateDirectoryFd(observed)).toBeUndefined();
        expect(core.statFd(observed).mode & 0o170000).toBe(0o040000);
      } finally {
        closeSync(observed);
      }
    } finally {
      parent.closeSync();
    }
  },
);

win(
  "private directory operations refuse existing names without repairing them",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    await broadenParent(root);
    await mkdir(join(root, "public"));
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "keep.txt"), "existing bytes");
    await writeFile(join(root, "outside", "sentinel.txt"), "outside bytes");
    await symlink(join(root, "outside"), join(root, "junction"), "junction");
    const parent = core.openRoot(root);
    try {
      const publicDirectory = core.openDirectoryAt(parent, "public");
      try {
        expect(() => core.checkPrivateDirectoryFd(publicDirectory)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
        for (const name of ["public", "keep.txt", "junction"])
          expect(() => core.createPrivateDirectoryAt(parent, name)).toThrow(
            expect.objectContaining({ code: "EEXIST" }),
          );
        expect(() => core.checkPrivateDirectoryFd(publicDirectory)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
      } finally {
        closeSync(publicDirectory);
      }
      const file = core.openFileAt(parent, "keep.txt");
      const junction = core.openMetadataAt(parent, "junction");
      try {
        expect(() => core.checkPrivateDirectoryFd(file)).toThrow(
          expect.objectContaining({ code: "ENOTDIR" }),
        );
        expect(() => core.checkPrivateDirectoryFd(junction)).toThrow(
          expect.objectContaining({ code: "ELOOP" }),
        );
      } finally {
        closeSync(file);
        closeSync(junction);
      }
      expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("existing bytes");
      expect(await readFile(join(root, "outside", "sentinel.txt"), "utf8")).toBe("outside bytes");
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "private directory creation remains in the pinned parent after replacement",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    const scope = join(root, "scope");
    const moved = join(root, "moved");
    await mkdir(scope);
    const parent = core.openRoot(scope);
    try {
      await rename(scope, moved);
      await mkdir(scope);
      await mkdir(join(scope, "private"));
      const child = core.createPrivateDirectoryAt(parent, "private");
      try {
        expect(core.checkPrivateDirectoryFd(child)).toBeUndefined();
        await writeFile(join(moved, "private", "kept.txt"), "pinned bytes");
      } finally {
        closeSync(child);
      }
      expect(await readFile(join(moved, "private", "kept.txt"), "utf8")).toBe("pinned bytes");
      const fresh = core.openRoot(scope);
      try {
        const decoy = core.openDirectoryAt(fresh, "private");
        try {
          expect(() => core.checkPrivateDirectoryFd(decoy)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );
        } finally {
          closeSync(decoy);
        }
      } finally {
        closeSync(fresh);
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "private directory creation rejects unsafe components and invalid descriptors",
  async ({ onTestFinished }) => {
    const { root, core } = await fixture(onTestFinished);
    const parent = core.openRoot(root);
    try {
      for (const name of ["", ".", "..", "../escape", "NUL", "file:stream", "trailing."])
        expect(() => core.createPrivateDirectoryAt(parent, name)).toThrow(
          expect.objectContaining({ code: "EINVAL" }),
        );
    } finally {
      closeSync(parent);
    }
    expect(() => core.createPrivateDirectoryAt(parent, "closed")).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => core.checkPrivateDirectoryFd(parent)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => core.checkPrivateDirectoryFd(-1)).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
  },
);
