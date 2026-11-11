import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectRoots } from "./project-roots.ts";

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A canonical home with folders, and roots kept in memory as the setting would keep them. */
async function rootsIn(names: readonly string[], options: { slowSave?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-roots-")));
  made.push(home);
  for (const name of names) await mkdir(join(home, name));
  let saved: string[] = [];
  const holds: (() => void)[] = [];
  const roots = new ProjectRoots({
    home,
    roots: async () => saved,
    saveRoots: async (next) => {
      // A slow settings write: the test lets each one finish.
      if (options.slowSave) await new Promise<void>((resolve) => holds.push(resolve));
      saved = next;
    },
  });
  return { home, roots, saved: () => saved, holds };
}
const allowed = () => {};

test("a remove started during an add's save removes from what the add saved, losing neither", async () => {
  const f = await rootsIn(["first", "later"], { slowSave: true });
  const adding = f.roots.add({ type: "workspace.root.add", path: join(f.home, "first") }, allowed);
  const removing = f.roots.remove(
    { type: "workspace.root.remove", path: join(f.home, "first") },
    allowed,
  );
  await expect.poll(() => f.holds.length).toBe(1);
  f.holds.shift()?.();
  await adding;
  await expect.poll(() => f.holds.length).toBe(1);
  f.holds.shift()?.();
  await removing;
  expect(f.saved()).toEqual([f.home]);
});

test("a whole roots write waits for an edit under way", async () => {
  const f = await rootsIn(["first"], { slowSave: true });
  const adding = f.roots.add({ type: "workspace.root.add", path: join(f.home, "first") }, allowed);
  const order: string[] = [];
  const writing = f.roots.exclusive(async () => void order.push("setting"));
  await expect.poll(() => f.holds.length).toBe(1);
  expect(order).toEqual([]);
  f.holds.shift()?.();
  await adding;
  await writing;
  expect(order).toEqual(["setting"]);
});

test("the last allowed root can't be removed, so home isn't allowed again", async () => {
  const f = await rootsIn(["only"]);
  let saved = [join(f.home, "only")];
  const roots = new ProjectRoots({
    home: f.home,
    roots: async () => saved,
    saveRoots: async (next) => void (saved = next),
  });
  await expect(
    roots.remove({ type: "workspace.root.remove", path: join(f.home, "only") }, allowed),
  ).rejects.toMatchObject({ code: "last_root" });
  expect(saved).toEqual([join(f.home, "only")]);
});

test("a root added through a symlink is removed by its real path", async () => {
  const f = await rootsIn(["real"]);
  const link = join(f.home, "link");
  await symlink(join(f.home, "real"), link);
  await f.roots.add({ type: "workspace.root.add", path: link }, allowed);
  expect(f.saved()).toEqual([f.home, join(f.home, "real")]);

  await f.roots.remove({ type: "workspace.root.remove", path: join(f.home, "real") }, allowed);
  expect(f.saved()).toEqual([f.home]);
});

test("a root added by its real path is removed through a symlink to it", async () => {
  const f = await rootsIn(["real"]);
  const link = join(f.home, "link");
  await symlink(join(f.home, "real"), link);
  await f.roots.add({ type: "workspace.root.add", path: join(f.home, "real") }, allowed);

  await f.roots.remove({ type: "workspace.root.remove", path: `${link}/` }, allowed);
  expect(f.saved()).toEqual([f.home]);
});
