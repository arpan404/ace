import { rename, symlink, unlink } from "node:fs/promises";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { basename, parse } from "node:path";
import { expect, it } from "vitest";
import { createWorkspace, filesystem, WorkspaceError } from "./index.ts";
import { SafeRoot } from "./index.ts";
import { fixture } from "./test-support.ts";

it("never exposes outside bytes during an ABA swap coordinated at filesystem boundaries", async () => {
  const inside = await fixture();
  const outside = await fixture();
  await inside.file("changing/file", "inside");
  await outside.file("file", "OUTSIDE SECRET");
  const parent = join(inside.service.root, "changing");
  const parked = join(inside.service.root, "parked");
  const target = join(parent, "file");
  let escaped = false;
  let armed = true;
  let opened = false;
  async function swap(out: boolean) {
    if (out === escaped) return;
    if (out) {
      await rename(parent, parked);
      await symlink(outside.root, parent);
    } else {
      await unlink(parent);
      await rename(parked, parent);
    }
    escaped = out;
  }
  const service = await createWorkspace(inside.root, {
    filesystem: {
      ...filesystem,
      async lstat(path) {
        if (armed && path === target) await swap(true);
        return filesystem.lstat(path);
      },
      async open(path, flags) {
        const handle = await filesystem.open(path, flags);
        if (path === target) opened = true;
        return handle;
      },
      async realpath(path) {
        if (armed && opened && path === parent) await swap(false);
        return filesystem.realpath(path);
      },
      async stat(path) {
        if (armed && opened && path === target) await swap(true);
        return filesystem.stat(path);
      },
    },
  });
  try {
    try {
      const result = await service.read({ path: "changing/file" });
      expect(result).toMatchObject({ text: "inside" });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      expect(error.code).toMatch(/^(PATH_ESCAPE|PATH_CHANGED|NOT_DIRECTORY)$/);
    }
  } finally {
    armed = false;
    await swap(false);
  }
  expect(await service.read({ path: "changing/file" })).toMatchObject({ text: "inside" });
});

it("rejects an in-root file replaced between metadata and descriptor acquisition", async () => {
  const { root, file } = await fixture();
  await file("value", "original");
  await file("replacement", "replacement bytes");
  const target = join(await filesystem.realpath(root), "value");
  let armed = true;
  const service = await createWorkspace(root, {
    filesystem: {
      ...filesystem,
      async lstat(path) {
        const expected = await filesystem.lstat(path);
        if (armed && path === target) {
          armed = false;
          await rename(join(root, "replacement"), target);
        }
        return expected;
      },
    },
  });
  await expect(service.read({ path: "value" })).rejects.toMatchObject({ code: "PATH_CHANGED" });
  expect(await service.read({ path: "value" })).toMatchObject({ text: "replacement bytes" });
});

it("reports a transient filesystem EINVAL as a changed path and permits a later stable read", async () => {
  const { root, file } = await fixture();
  await file("a", "stable");
  let changed = true;
  const service = await createWorkspace(root, {
    filesystem: {
      ...filesystem,
      async lstat(path) {
        if (changed) {
          changed = false;
          throw Object.assign(new Error("path swapped during lstat"), { code: "EINVAL" });
        }
        return filesystem.lstat(path);
      },
    },
  });
  await expect(service.read({ path: "a" })).rejects.toMatchObject({ code: "PATH_CHANGED" });
  expect(await service.read({ path: "a" })).toMatchObject({ text: "stable" });
});

it("anchors the root itself when an ancestor is swapped during service creation and verification", async () => {
  const base = await fixture();
  const outside = await fixture();
  await base.file("parent/root/a", "inside");
  await outside.file("root/a", "OUTSIDE SECRET");
  const parent = join(base.service.root, "parent");
  const parked = join(base.service.root, "parked");
  const root = join(parent, "root");
  let escaped = false;
  let armed = true;
  async function swap(out: boolean) {
    if (escaped === out) return;
    if (out) {
      await rename(parent, parked);
      await symlink(outside.root, parent);
    } else {
      await unlink(parent);
      await rename(parked, parent);
    }
    escaped = out;
  }
  const service = await createWorkspace(root, {
    filesystem: {
      ...filesystem,
      async realpath(path) {
        if (armed && path.startsWith(root)) await swap(false);
        return filesystem.realpath(path);
      },
      async stat(path) {
        if (armed && path.startsWith(root)) await swap(true);
        return filesystem.stat(path);
      },
      async lstat(path) {
        if (armed && path.startsWith(root)) await swap(true);
        return filesystem.lstat(path);
      },
    },
  });
  try {
    try {
      expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      expect(error.code).toMatch(/^(PATH_ESCAPE|PATH_CHANGED|NOT_DIRECTORY)$/);
    }
  } finally {
    armed = false;
    await swap(false);
  }
  expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
});

it("rejects an ancestor symlink inserted after realpath returns during root acquisition", async () => {
  const base = await fixture();
  const outside = await fixture();
  await base.file("parent/root/a", "inside");
  await outside.file("root/a", "OUTSIDE SECRET");
  const parent = join(base.service.root, "parent");
  const parked = join(base.service.root, "parked");
  const root = join(parent, "root");
  let escaped = false;
  let armed = true;
  let initializing = true;
  async function swap(out: boolean) {
    if (escaped === out) return;
    if (out) {
      await rename(parent, parked);
      await symlink(outside.root, parent);
    } else {
      await unlink(parent);
      await rename(parked, parent);
    }
    escaped = out;
  }
  let service;
  try {
    try {
      service = await createWorkspace(root, {
        filesystem: {
          ...filesystem,
          async realpath(path) {
            if (armed && path.startsWith(root)) await swap(false);
            const resolved = await filesystem.realpath(path);
            if (armed && initializing && path === root) {
              initializing = false;
              await swap(true);
            }
            return resolved;
          },
          async stat(path) {
            if (armed && path.startsWith(root)) await swap(true);
            return filesystem.stat(path);
          },
          async lstat(path) {
            if (armed && path.startsWith(root)) await swap(true);
            return filesystem.lstat(path);
          },
        },
      });
      expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      expect(error.code).toMatch(/^(PATH_ESCAPE|PATH_CHANGED|NOT_DIRECTORY)$/);
    }
  } finally {
    armed = false;
    await swap(false);
  }
  service ??= await createWorkspace(root);
  expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
});

// Windows cases. Directory links are junctions, which need no privilege.
const windowsOnly = it.runIf(process.platform === "win32");
const junction = (target: string, path: string) => symlink(target, path, "junction");

/** Swaps `parent` for a junction to `outside` and back, as the ABA tests above do with symlinks. */
function junctionSwap(parent: string, parked: string, outside: string) {
  let escaped = false;
  return {
    get escaped() {
      return escaped;
    },
    async swap(out: boolean) {
      if (out === escaped) return;
      if (out) {
        await rename(parent, parked);
        await junction(outside, parent);
      } else {
        await unlink(parent);
        await rename(parked, parent);
      }
      escaped = out;
    },
  };
}
const changed = /^(PATH_ESCAPE|PATH_CHANGED|NOT_DIRECTORY)$/;

windowsOnly("Windows never exposes outside bytes during a junction ABA swap", async () => {
  const inside = await fixture();
  const outside = await fixture();
  await inside.file("changing/file", "inside");
  await outside.file("file", "OUTSIDE SECRET");
  const parent = join(inside.service.root, "changing");
  const target = join(parent, "file");
  const swapper = junctionSwap(parent, join(inside.service.root, "parked"), outside.root);
  let armed = true;
  let opened = false;
  const service = await createWorkspace(inside.root, {
    filesystem: {
      ...filesystem,
      async lstat(path) {
        if (armed && path === target) await swapper.swap(true);
        return filesystem.lstat(path);
      },
      async open(path, flags) {
        const handle = await filesystem.open(path, flags);
        if (path === target) opened = true;
        return handle;
      },
      async realpath(path) {
        if (armed && opened && path === parent) await swapper.swap(false);
        return filesystem.realpath(path);
      },
      async stat(path) {
        if (armed && opened && path === target) await swapper.swap(true);
        return filesystem.stat(path);
      },
    },
  });
  try {
    try {
      expect(await service.read({ path: "changing/file" })).toMatchObject({ text: "inside" });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      expect(error.code).toMatch(changed);
    }
  } finally {
    armed = false;
    await swapper.swap(false);
  }
  expect(await service.read({ path: "changing/file" })).toMatchObject({ text: "inside" });
});

for (const late of [false, true]) {
  windowsOnly(
    `Windows anchors the root when an ancestor becomes a junction ${late ? "after realpath returns" : "during creation and verification"}`,
    async () => {
      const base = await fixture();
      const outside = await fixture();
      await base.file("parent/root/a", "inside");
      await outside.file("root/a", "OUTSIDE SECRET");
      const parent = join(base.service.root, "parent");
      const root = join(parent, "root");
      const swapper = junctionSwap(parent, join(base.service.root, "parked"), outside.root);
      let armed = true;
      let initializing = late;
      let service;
      try {
        try {
          service = await createWorkspace(root, {
            filesystem: {
              ...filesystem,
              async realpath(path) {
                if (armed && path.startsWith(root)) await swapper.swap(false);
                const resolved = await filesystem.realpath(path);
                if (armed && initializing && path === root) {
                  initializing = false;
                  await swapper.swap(true);
                }
                return resolved;
              },
              async stat(path) {
                if (armed && path.startsWith(root)) await swapper.swap(true);
                return filesystem.stat(path);
              },
              async lstat(path) {
                if (armed && path.startsWith(root)) await swapper.swap(true);
                return filesystem.lstat(path);
              },
            },
          });
          expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          expect(error.code).toMatch(changed);
        }
      } finally {
        armed = false;
        await swapper.swap(false);
      }
      service ??= await createWorkspace(root);
      expect(await service.read({ path: "a" })).toMatchObject({ text: "inside" });
    },
  );
}

windowsOnly(
  "Windows mutations refuse case and short-name aliases of .git and upload temporaries",
  async ({ skip }) => {
    const { root, file } = await fixture();
    await file(".git/owned", "git bytes");
    await file(".ace-upload-abc", "private bytes");
    await file("plain/kept.txt", "kept");
    const safe = await SafeRoot.create(root);
    for (const path of [".GIT/owned", ".Git/", ".gIt", ".ACE-UPLOAD-abc", "plain/.Ace-Upload-x"])
      await expect(safe.target(path)).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(safe.target("plain/kept.txt")).resolves.toMatchObject({
      path: join(safe.root, "plain", "kept.txt"),
    });
    // 8.3 names exist only where the volume generates them; cmd reports the short form.
    const { stdout } = await promisify(execFile)("cmd.exe", [
      "/d",
      "/c",
      `for %I in ("${join(safe.root, ".git")}") do @echo %~sI`,
    ]);
    const short = basename(stdout.trim());
    if (short.toLowerCase() === ".git") skip("This volume does not generate 8.3 names");
    for (const path of [`${short}/owned`, short, `${short}/new-file`])
      await expect(safe.target(path)).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await readFile(join(root, ".git", "owned"), "utf8")).toBe("git bytes");
  },
);

const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

windowsOnly("Windows workspaces read, list and search Unicode files", async () => {
  const { root, file } = await fixture();
  await file("dossier-日本語/café-✓.txt", "first\nneedle 日本語\n");
  const workspace = await createWorkspace(root, { ripgrep: null });
  expect(await workspace.read({ path: "dossier-日本語/café-✓.txt" })).toMatchObject({
    text: "first\nneedle 日本語\n",
  });
  const listed = await workspace.list({ dir: "dossier-日本語" });
  expect(listed.entries.map((entry) => entry.path)).toEqual(["dossier-日本語/café-✓.txt"]);
  const found = await workspace.search({ query: "needle", limit: 1 });
  expect(found.matches).toMatchObject([{ path: "dossier-日本語/café-✓.txt", line: 2 }]);
  const { info } = await (await SafeRoot.create(root)).metadata("dossier-日本語/café-✓.txt");
  expect(info.size).toBe(Buffer.byteLength("first\nneedle 日本語\n"));
});

windowsOnly("Windows workspaces refuse an outward junction and a replaced root", async () => {
  const { root, service, file } = await fixture();
  const outside = await fixture();
  await file("inside.txt", "original");
  await outside.file("secret.txt", "outside bytes");
  await junction(outside.root, join(root, "escape"));
  await expect(service.read({ path: "escape/secret.txt" })).rejects.toMatchObject({
    code: "PATH_ESCAPE",
  });
  await expect(service.list({ dir: "escape" })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  // Move the original root inside a fresh one at its pathname, so cleanup still finds it.
  await rename(root, root + "-backup");
  await mkdir(root);
  await writeFile(join(root, "inside.txt"), "replacement");
  await rename(root + "-backup", join(root, "moved"));
  await expect(service.read({ path: "inside.txt" })).rejects.toMatchObject({
    code: "PATH_CHANGED",
  });
  expect(await readFile(join(outside.root, "secret.txt"), "utf8")).toBe("outside bytes");
});

windowsOnly("Windows path stat follows a junction while lstat describes the junction", async () => {
  const { root, file } = await fixture();
  await file("outside/sentinel.txt", "outside");
  await file("scope/hello.txt", "hello");
  const linked = join(root, "scope", "junction");
  await junction(join(root, "outside"), linked);
  const regular = join(root, "scope", "hello.txt");
  expect(same(await filesystem.stat(regular), await filesystem.lstat(regular))).toBe(true);
  const followed = await filesystem.stat(linked);
  expect(followed.isDirectory()).toBe(true);
  expect(same(followed, await filesystem.stat(join(root, "outside")))).toBe(true);
  const itself = await filesystem.lstat(linked);
  expect(itself.isSymbolicLink()).toBe(true);
  expect(same(itself, followed)).toBe(false);
  expect((await filesystem.lstat(linked + "\\")).isSymbolicLink()).toBe(
    (await lstat(linked + "\\")).isSymbolicLink(),
  );
  const drive = parse(await filesystem.realpath(root)).root;
  expect(same(await filesystem.stat(drive), await filesystem.lstat(drive))).toBe(true);
  await expect(filesystem.lstat(join(root, "NUL"))).rejects.toMatchObject({ code: "EINVAL" });
  for (const path of ["C:relative", "\\absolute", "\\\\?\\C:\\file", "\\\\.\\C:\\file"])
    await expect(filesystem.stat(path)).rejects.toMatchObject({ code: "EINVAL" });
  await expect(filesystem.stat("\\\\ace-invalid\\share\\file")).rejects.toMatchObject({
    code: "ENOTSUP",
  });
});
