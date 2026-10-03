import { rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorkspace, filesystem, WorkspaceError } from "./index.ts";
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
