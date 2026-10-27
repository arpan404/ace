import { afterEach, expect, test } from "vitest";
import { closeSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openRoot, renameAt, renameAtNoReplace } from "@ace/workspace/descriptor";
import {
  linkCommandEntry,
  openCommandChild,
  openResolvedDirectory,
  readCommandLink,
  renameCommandEntryAs,
} from "./posix.ts";

// Handle-relative links, no-replace moves and handle paths on Windows; every case runs only there.
const windows = test.runIf(process.platform === "win32");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-handle-links-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function pinned(path: string) {
  const fd = await openResolvedDirectory(openCommandChild, path);
  cleanups.push(async () => closeSync(fd));
  return fd;
}

windows("Windows a skill link is a junction made through the pinned folder", async () => {
  const base = await home();
  const root = join(base, "skills");
  const canonical = join(base, "library", "pdf");
  await mkdir(root);
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), "pdf");
  const fd = await pinned(root);
  const target = relative(root, canonical);
  expect(await linkCommandEntry(target, fd, "pdf")).toBe(true);
  expect((await lstat(join(root, "pdf"))).isSymbolicLink()).toBe(true);
  expect(await realpath(join(root, "pdf"))).toBe(canonical);
  expect(await readFile(join(root, "pdf", "SKILL.md"), "utf8")).toBe("pdf");
  expect(await readCommandLink(fd, "pdf")).toBe(target);
  // An existing name fails the create itself and is left as it was.
  expect(await linkCommandEntry(target, fd, "pdf")).toBe(false);
  expect(await realpath(join(root, "pdf"))).toBe(canonical);
});

windows(
  "Windows a skill link made while the skills folder is swapped for a junction never lands outside the link root",
  async () => {
    const base = await home();
    const root = join(base, "skills");
    const moved = join(base, "moved");
    const outside = join(base, "outside");
    const canonical = join(base, "library", "pdf");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(canonical, { recursive: true });
    const fd = await pinned(root);
    // The held folder moves away and its path now leads outside, as in a same-user swap.
    await rename(root, moved);
    await symlink(outside, root, "junction");
    await linkCommandEntry(relative(root, canonical), fd, "pdf");
    expect(await readdir(outside)).toEqual([]);
    // Like symlinkat, the link lands in the folder the handle holds.
    expect(await readdir(moved)).toEqual(["pdf"]);
    expect((await lstat(join(moved, "pdf"))).isSymbolicLink()).toBe(true);
  },
);

windows("Windows no-replace rename refuses an existing file", async () => {
  const base = await home();
  await writeFile(join(base, "a"), "first");
  await writeFile(join(base, "b"), "second");
  await mkdir(join(base, "folder"));
  const fd = await pinned(base);
  expect(await renameCommandEntryAs("noReplace", fd, "a", fd, "b")).toBe(false);
  expect(await renameCommandEntryAs("noReplace", fd, "a", fd, "folder")).toBe(false);
  expect(await readFile(join(base, "a"), "utf8")).toBe("first");
  expect(await readFile(join(base, "b"), "utf8")).toBe("second");
  const raw = openRoot(base);
  cleanups.push(async () => closeSync(raw.fd));
  expect(() => renameAtNoReplace(raw.fd, "a", "b")).toThrow(
    expect.objectContaining({ code: "EEXIST" }),
  );
  expect(await readFile(join(base, "b"), "utf8")).toBe("second");
  // A free name still moves, and the plain rename still replaces.
  expect(await renameCommandEntryAs("noReplace", fd, "a", fd, "c")).toBe(true);
  expect(await readFile(join(base, "c"), "utf8")).toBe("first");
  renameAt(raw.fd, "c", "b");
  expect(await readFile(join(base, "b"), "utf8")).toBe("first");
});

windows("Windows a reused fd number never inherits a closed handle's path", async () => {
  const base = await home();
  const first = join(base, "first");
  const second = join(base, "second");
  await mkdir(join(first, "inner"), { recursive: true });
  await mkdir(join(second, "inner"), { recursive: true });
  const closed = await openResolvedDirectory(openCommandChild, first);
  closeSync(closed);
  // Open the other folder outside the command helpers until it gets the closed fd's number.
  const extra: number[] = [];
  let reused: number | undefined;
  for (let attempt = 0; attempt < 64 && reused === undefined; attempt++) {
    const fd = openRoot(second).fd;
    if (fd === closed) reused = fd;
    else extra.push(fd);
  }
  for (const fd of extra) closeSync(fd);
  expect(reused).toBe(closed);
  if (reused === undefined) return;
  cleanups.push(async () => closeSync(closed));
  await expect(openCommandChild(reused, "inner", 0)).rejects.toThrow(
    "Unknown command directory handle",
  );
});
