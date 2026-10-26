import { lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { expect, it } from "vitest";
import { createWorkspace, filesystem, SafeRoot, WorkspaceError } from "./index.ts";
import { sameFile } from "./pinned-directory.ts";
import { fixture } from "./test-support.ts";

const platform = process.platform;
const windowsOnly = it.runIf(platform === "win32");

/** A directory link: a junction on Windows, which needs no privilege; a symlink elsewhere. */
function linkDirectory(target: string, path: string): Promise<void> {
  return symlink(target, path, "junction");
}

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
      await linkDirectory(outside.root, parent);
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
      await linkDirectory(outside.root, parent);
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
      await linkDirectory(outside.root, parent);
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

it("reads, lists and searches Unicode files with lossless identity", async () => {
  const { root, file } = await fixture();
  await file("dossier-日本語/café-✓.txt", "first\nneedle 日本語\n");
  const workspace = await createWorkspace(root, { ripgrep: null });
  expect(await workspace.read({ path: "dossier-日本語/café-✓.txt" })).toMatchObject({
    text: "first\nneedle 日本語\n",
    binary: false,
  });
  const listed = await workspace.list({ dir: "dossier-日本語" });
  expect(listed.entries.map((entry) => entry.path)).toEqual(["dossier-日本語/café-✓.txt"]);
  const found = await workspace.search({ query: "needle", limit: 1 });
  expect(found.matches).toMatchObject([
    { path: "dossier-日本語/café-✓.txt", line: 2, preview: "needle 日本語" },
  ]);
  const { info } = await (await SafeRoot.create(root)).metadata("dossier-日本語/café-✓.txt");
  expect(info.identity.kind).toBe(platform === "win32" ? "win32" : "posix");
  expect(info.isFile()).toBe(true);
  expect(info.size).toBe(Buffer.byteLength("first\nneedle 日本語\n"));
});

it("refuses a directory link out of the workspace and a replaced workspace root", async () => {
  const { root, service, file } = await fixture();
  const outside = await fixture();
  await file("inside.txt", "original");
  await outside.file("secret.txt", "outside bytes");
  await linkDirectory(outside.root, join(root, "escape"));
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

it("path stat follows a directory link while lstat describes the link itself", async () => {
  const { root, file } = await fixture();
  await file("outside/sentinel.txt", "outside");
  await file("scope/hello-✓.txt", "hello filesystem");
  const link = join(root, "scope", "link");
  await linkDirectory(join(root, "outside"), link);

  const regular = await filesystem.stat(join(root, "scope", "hello-✓.txt"));
  expect(regular.isFile()).toBe(true);
  expect(regular.size).toBe(Buffer.byteLength("hello filesystem"));
  const sameRegular = await filesystem.lstat(join(root, "scope", "hello-✓.txt"));
  expect(sameFile(sameRegular.identity, regular.identity)).toBe(true);

  const followed = await filesystem.stat(link);
  expect(followed.isDirectory()).toBe(true);
  expect(sameFile(followed.identity, (await filesystem.stat(join(root, "outside"))).identity)).toBe(
    true,
  );
  const itself = await filesystem.lstat(link);
  expect(itself.isSymbolicLink()).toBe(true);
  expect(itself.isDirectory()).toBe(false);
  expect(sameFile(itself.identity, followed.identity)).toBe(false);
  // A trailing separator asks for the target, exactly as Node's own lstat reports it.
  const sep = platform === "win32" ? "\\" : "/";
  const expected = await lstat(link + sep);
  const observed = await filesystem.lstat(link + sep);
  expect(observed.isSymbolicLink()).toBe(expected.isSymbolicLink());
  expect(observed.isDirectory()).toBe(expected.isDirectory());

  const top = parse(await filesystem.realpath(root)).root;
  const drive = await filesystem.stat(top);
  expect(drive.isDirectory()).toBe(true);
  expect(sameFile(drive.identity, (await filesystem.lstat(top)).identity)).toBe(true);
  await expect(filesystem.stat(join(root, "missing.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(filesystem.lstat(join(root, "missing.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

windowsOnly(
  "Windows device, UNC and drive-relative paths are refused before resolution",
  async () => {
    const { root, file } = await fixture();
    await file("ok.txt", "ok");
    await expect(filesystem.lstat(join(root, "NUL"))).rejects.toMatchObject({ code: "EINVAL" });
    for (const path of ["C:relative", "\\absolute", "\\\\?\\C:\\file", "\\\\.\\C:\\file"]) {
      await expect(filesystem.stat(path)).rejects.toMatchObject({ code: "EINVAL" });
      await expect(filesystem.lstat(path)).rejects.toMatchObject({ code: "EINVAL" });
    }
    await expect(filesystem.stat("\\\\ace-invalid\\share\\file")).rejects.toMatchObject({
      code: "ENOTSUP",
    });
    expect((await filesystem.stat(join(root, "ok.txt"))).isFile()).toBe(true);
  },
);
