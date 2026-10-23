import { closeSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  checkPrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  securePrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
});
const win = test.runIf(process.platform === "win32");
const runFile = promisify(execFile);

function systemPowerShell(): string {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
}

// Owner-only DACL via documented .NET FileSecurity: current TokenUser owns,
// inheritance disabled and stripped, then one FullControl allow (zero flags,
// FILE_ALL_ACCESS) for the owner. Optional Everyone reader broadens it.
const SET_DACL_PS = [
  "$ErrorActionPreference='Stop'",
  "$p=$env:ACE_PRIVATE_TARGET",
  "$x=$env:ACE_PRIVATE_EXTRA",
  "$a=[System.IO.File]::GetAccessControl($p)",
  "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$a.SetOwner($m)",
  "$a.SetAccessRuleProtection($true,$false)",
  "foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleAll($r)}",
  "$o=[System.Security.AccessControl.FileSystemAccessRule]::new($m,'FullControl','Allow')",
  "$a.AddAccessRule($o)",
  "$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
  "if($x -eq 'read'){$e=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute','Allow');$a.AddAccessRule($e)} elseif($x -eq 'full'){$e=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'FullControl','Allow');$a.AddAccessRule($e)}",
  "[System.IO.File]::SetAccessControl($p,$a)",
].join(";");

async function secureOwnerOnly(target: string, extra = "none"): Promise<void> {
  await runFile(
    systemPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SET_DACL_PS],
    { env: { ...process.env, ACE_PRIVATE_TARGET: target, ACE_PRIVATE_EXTRA: extra } },
  );
}

// Owner precondition only: points the file owner at the current TokenUser
// while leaving the existing DACL (inherited or broad) untouched, so the
// setter-behavior fixtures start from a known owner without pre-securing.
const SET_OWNER_PS = [
  "$ErrorActionPreference='Stop'",
  "$p=$env:ACE_PRIVATE_TARGET",
  "$a=[System.IO.File]::GetAccessControl($p)",
  "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$a.SetOwner($m)",
  "[System.IO.File]::SetAccessControl($p,$a)",
].join(";");

async function ensureOwner(target: string): Promise<void> {
  await runFile(
    systemPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SET_OWNER_PS],
    { env: { ...process.env, ACE_PRIVATE_TARGET: target } },
  );
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (caught) {
    expect(caught).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected failure with code ${code}, got success`);
}

win("accepts an owner-only Unicode regular file as private", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await mkdtemp(join(tmpdir(), "ace-wprivate-ok-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const name = "privé-日本語-✓.txt";
  await writeFile(join(root, name), "secret bytes");
  await secureOwnerOnly(join(root, name));
  const parent = core.openRoot(root);
  try {
    expect(core.checkPrivateAt(parent, name)).toBeUndefined();
    expect(await readFile(join(root, name), "utf8")).toBe("secret bytes");
  } finally {
    closeSync(parent);
  }
});

win("rejects inherited and broadened DACLs with EACCES", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await mkdtemp(join(tmpdir(), "ace-wprivate-acl-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "hérité-日本語.txt"), "inherited");
  await writeFile(join(root, "lecture-✓.txt"), "reader");
  await writeFile(join(root, "large-日本語.txt"), "broad");
  await secureOwnerOnly(join(root, "lecture-✓.txt"), "read");
  await secureOwnerOnly(join(root, "large-日本語.txt"), "full");
  const parent = core.openRoot(root);
  try {
    for (const name of ["hérité-日本語.txt", "lecture-✓.txt", "large-日本語.txt"])
      expectCode(() => core.checkPrivateAt(parent, name), "EACCES");
  } finally {
    closeSync(parent);
  }
});

win("refuses a hard link even after owner-only security", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await mkdtemp(join(tmpdir(), "ace-wprivate-link-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const name = "origine-日本語-✓.txt";
  const alias = "alias-✓.txt";
  await writeFile(join(root, name), "linked bytes");
  await link(join(root, name), join(root, alias));
  await secureOwnerOnly(join(root, name));
  const parent = core.openRoot(root);
  try {
    expectCode(() => core.checkPrivateAt(parent, name), "EACCES");
    expectCode(() => core.checkPrivateAt(parent, alias), "EACCES");
    expect(await readFile(join(root, name), "utf8")).toBe("linked bytes");
  } finally {
    closeSync(parent);
  }
});

win("rejects directories with EISDIR and junctions with ELOOP", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const base = await mkdtemp(join(tmpdir(), "ace-wprivate-type-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, "dossier-日本語"));
  await writeFile(join(outside, "keep-✓.txt"), "outside bytes");
  try {
    await symlink(outside, join(root, "lien-✓"), "junction");
  } catch {
    throw new Error("Windows host cannot create junctions; reparse refusal untestable here");
  }
  const parent = core.openRoot(root);
  try {
    expectCode(() => core.checkPrivateAt(parent, "dossier-日本語"), "EISDIR");
    expectCode(() => core.checkPrivateAt(parent, "lien-✓"), "ELOOP");
    expect((await lstat(join(root, "lien-✓"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "keep-✓.txt"), "utf8")).toBe("outside bytes");
  } finally {
    closeSync(parent);
  }
});

win("rejects bad lexical names with EINVAL", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const root = await mkdtemp(join(tmpdir(), "ace-wprivate-names-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok-✓.txt"), "ok");
  await secureOwnerOnly(join(root, "ok-✓.txt"));
  const parent = core.openRoot(root);
  try {
    expect(core.checkPrivateAt(parent, "ok-✓.txt")).toBeUndefined();
    for (const name of ["..", "../escape", "NUL.txt", "file:stream", "trailing.", "a/b", ""])
      expectCode(() => core.checkPrivateAt(parent, name), "EINVAL");
    expectCode(() => core.checkPrivateAt(parent, "missing-✓.txt"), "ENOENT");
  } finally {
    closeSync(parent);
  }
});

win(
  "secure heals inherited and broadened files without touching contents",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wprivate-secure-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "hérité-日本語.txt"), "inherited bytes");
    await writeFile(join(root, "élargi-✓.txt"), "broadened bytes");
    await ensureOwner(join(root, "hérité-日本語.txt"));
    await secureOwnerOnly(join(root, "élargi-✓.txt"), "read");
    const parent = core.openRoot(root);
    try {
      for (const [name, bytes] of [
        ["hérité-日本語.txt", "inherited bytes"],
        ["élargi-✓.txt", "broadened bytes"],
      ] as const) {
        expectCode(() => core.checkPrivateAt(parent, name), "EACCES");
        expect(core.securePrivateAt(parent, name)).toBeUndefined();
        expect(core.checkPrivateAt(parent, name)).toBeUndefined();
        expect(await readFile(join(root, name), "utf8")).toBe(bytes);
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "setter refuses hard links and junctions without changing outside bytes",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const base = await mkdtemp(join(tmpdir(), "ace-wprivate-setterlinks-"));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "origine-日本語-✓.txt"), "linked bytes");
    await link(join(root, "origine-日本語-✓.txt"), join(root, "alias-✓.txt"));
    await writeFile(join(outside, "keep-✓.txt"), "outside bytes");
    try {
      await symlink(outside, join(root, "lien-✓"), "junction");
    } catch {
      throw new Error("Windows host cannot create junctions; reparse refusal untestable here");
    }
    const parent = core.openRoot(root);
    try {
      expectCode(() => core.securePrivateAt(parent, "origine-日本語-✓.txt"), "EACCES");
      expectCode(() => core.securePrivateAt(parent, "alias-✓.txt"), "EACCES");
      expectCode(() => core.securePrivateAt(parent, "lien-✓"), "ELOOP");
      expect(await readFile(join(root, "origine-日本語-✓.txt"), "utf8")).toBe("linked bytes");
      expect(await readFile(join(outside, "keep-✓.txt"), "utf8")).toBe("outside bytes");
    } finally {
      closeSync(parent);
    }
  },
);

win("a replaced ancestor cannot redirect the secure operation", async ({ onTestFinished }) => {
  const core = Binding.parse(require("../dist/windows-core.node"));
  const base = await mkdtemp(join(tmpdir(), "ace-wprivate-ancestor-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const scope = join(base, "scope");
  await mkdir(scope);
  await writeFile(join(scope, "slot-✓.txt"), "pinned bytes");
  await ensureOwner(join(scope, "slot-✓.txt"));
  const parent = core.openRoot(scope);
  try {
    expectCode(() => core.checkPrivateAt(parent, "slot-✓.txt"), "EACCES");
    await rename(scope, join(base, "scope-moved"));
    await mkdir(scope);
    await writeFile(join(scope, "slot-✓.txt"), "decoy bytes");
    expect(core.securePrivateAt(parent, "slot-✓.txt")).toBeUndefined();
    expect(core.checkPrivateAt(parent, "slot-✓.txt")).toBeUndefined();
  } finally {
    closeSync(parent);
  }
  const moved = core.openRoot(join(base, "scope-moved"));
  try {
    expect(core.checkPrivateAt(moved, "slot-✓.txt")).toBeUndefined();
    expect(await readFile(join(base, "scope-moved", "slot-✓.txt"), "utf8")).toBe("pinned bytes");
  } finally {
    closeSync(moved);
  }
  const fresh = core.openRoot(scope);
  try {
    expectCode(() => core.checkPrivateAt(fresh, "slot-✓.txt"), "EACCES");
    expect(await readFile(join(scope, "slot-✓.txt"), "utf8")).toBe("decoy bytes");
  } finally {
    closeSync(fresh);
  }
});
