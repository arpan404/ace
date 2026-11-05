import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalPath } from "./realpath.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "locked"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-realpath-")));
  roots.push(path);
  return path;
}

test.each([0o000, 0o200, 0o100])(
  "a file with mode %o resolves to its canonical path though it can't be opened",
  async (mode) => {
    const dir = await root();
    await writeFile(join(dir, "f"), "x", { mode });
    await mkdir(join(dir, "sub"));
    expect(await canonicalPath(join(dir, "sub", "..", "f"))).toBe(join(dir, "f"));
  },
);

test("a link to an unreadable file resolves to the file, through a link in its parent too", async () => {
  const dir = await root();
  await mkdir(join(dir, "real"));
  await writeFile(join(dir, "real", "f"), "x", { mode: 0o000 });
  await symlink("real", join(dir, "alias"));
  await symlink(join("..", "real", "f"), join(dir, "real", "link"));
  expect(await canonicalPath(join(dir, "alias", "link"))).toBe(join(dir, "real", "f"));
});

test("an unreadable folder resolves, and a missing leaf still fails as missing", async () => {
  const dir = await root();
  await mkdir(join(dir, "locked"), { mode: 0o100 });
  expect(await canonicalPath(join(dir, "locked"))).toBe(join(dir, "locked"));
  await expect(canonicalPath(join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
});
