import { closeSync, readFileSync } from "node:fs";
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
import { expect, test } from "vitest";
import { z } from "zod";
import { secureOwnerOnly, ensureOwner } from "./windows-private-fixture.ts";

const require = createRequire(import.meta.url);
const Binding = z.object({
  openRoot: z.function({ input: [z.string()], output: z.number().int() }),
  openFileAt: z.function({ input: [z.number().int(), z.string()], output: z.number().int() }),
  checkPrivateFd: z.function({ input: [z.number().int()], output: z.void() }),
  checkPrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  securePrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
});
const win = test.runIf(process.platform === "win32");
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

win(
  "checks private security on the opened file after its name is replaced",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wprivate-fd-swap-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const name = "secret-日本語.txt";
    await writeFile(join(root, name), "pinned private bytes");
    await secureOwnerOnly(join(root, name));
    const parent = core.openRoot(root);
    try {
      const original = core.openFileAt(parent, name);
      try {
        await rename(join(root, name), join(root, "held.txt"));
        await writeFile(join(root, name), "public replacement");
        await secureOwnerOnly(join(root, name), "read");
        expect(core.checkPrivateFd(original)).toBeUndefined();
        expectCode(() => core.checkPrivateAt(parent, name), "EACCES");
        expect(readFileSync(original, "utf8")).toBe("pinned private bytes");
        expect(await readFile(join(root, name), "utf8")).toBe("public replacement");
      } finally {
        closeSync(original);
      }

      const broad = core.openFileAt(parent, name);
      try {
        await rename(join(root, name), join(root, "broad.txt"));
        await writeFile(join(root, name), "private replacement");
        await secureOwnerOnly(join(root, name));
        expectCode(() => core.checkPrivateFd(broad), "EACCES");
        expect(core.checkPrivateAt(parent, name)).toBeUndefined();
        expect(readFileSync(broad, "utf8")).toBe("public replacement");
      } finally {
        closeSync(broad);
      }
    } finally {
      closeSync(parent);
    }
  },
);

win(
  "refuses hardlinked, directory and closed descriptors as private",
  async ({ onTestFinished }) => {
    const core = Binding.parse(require("../dist/windows-core.node"));
    const root = await mkdtemp(join(tmpdir(), "ace-wprivate-fd-refuse-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "linked.txt"), "linked bytes");
    await secureOwnerOnly(join(root, "linked.txt"));
    await link(join(root, "linked.txt"), join(root, "alias.txt"));
    const parent = core.openRoot(root);
    const child = core.openFileAt(parent, "linked.txt");
    try {
      expectCode(() => core.checkPrivateFd(child), "EACCES");
      expectCode(() => core.checkPrivateFd(parent), "EISDIR");
      expectCode(() => core.checkPrivateFd(-1), "EINVAL");
    } finally {
      closeSync(child);
      closeSync(parent);
    }
    expectCode(() => core.checkPrivateFd(child), "EBADF");
  },
);
