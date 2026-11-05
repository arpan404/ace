import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalPath } from "./realpath.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await chmod(join(dir, "locked"), 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
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

test("a link whose target climbs out of another link resolves through that link first", async () => {
  const dir = await root();
  // alias -> deep/subdir, so alias/.. is deep, not the root.
  await mkdir(join(dir, "deep", "subdir"), { recursive: true });
  await symlink(join("deep", "subdir"), join(dir, "alias"));
  await writeFile(join(dir, "deep", "locked"), "right", { mode: 0o000 });
  await writeFile(join(dir, "locked"), "wrong", { mode: 0o000 });
  // Written as is: join would fold alias/.. away before the link exists.
  await symlink("alias/../locked", join(dir, "link"));
  expect(await canonicalPath(join(dir, "link"))).toBe(join(dir, "deep", "locked"));
});

test("an unreadable file named with another case resolves to the name its folder stores", async () => {
  const dir = await root();
  await writeFile(join(dir, "Mixed"), "x", { mode: 0o000 });
  if (existsSync(join(dir, "MIXED")))
    expect(await canonicalPath(join(dir, "MIXED"))).toBe(join(dir, "Mixed"));
  else await expect(canonicalPath(join(dir, "MIXED"))).rejects.toMatchObject({ code: "ENOENT" });
});
