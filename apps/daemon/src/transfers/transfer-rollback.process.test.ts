import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PinnedDirectory } from "@ace/workspace";
import { folderIdentity, removeIfOwned } from "./files.ts";

const made: string[] = [];
afterEach(async () => {
  for (const path of made.splice(0)) await rm(path, { recursive: true, force: true });
});

it("rolls back a landed folder holding more than 10,000 entries without leaving any behind", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-rollback-")));
  made.push(root);
  const landed = join(root, "project");
  const deps = join(landed, "node_modules");
  await mkdir(deps, { recursive: true });
  const names = Array.from({ length: 10_050 }, (_, n) => `file-${n}.js`);
  for (let start = 0; start < names.length; start += 500)
    await Promise.all(
      names.slice(start, start + 500).map((name) => writeFile(join(deps, name), "")),
    );
  await mkdir(join(deps, "nested"));
  await writeFile(join(deps, "nested", "index.js"), "1\n");
  // A link out of the folder is removed itself; what it points at stays.
  const outside = join(root, "outside.txt");
  await writeFile(outside, "keep\n");
  await symlink(outside, join(deps, "escape"));
  const id = folderIdentity(await stat(landed));

  const parent = { handle: PinnedDirectory.open(root), path: root };
  try {
    expect(removeIfOwned(parent, "project", id)).toBe(true);
  } finally {
    parent.handle.closeSync();
  }
  expect(await readdir(root)).toEqual(["outside.txt"]);
  expect((await lstat(outside)).isFile()).toBe(true);
});
