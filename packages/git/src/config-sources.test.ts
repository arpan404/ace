import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { listedSources, watchedPaths } from "./config-sources.ts";

const layout = { gitDir: "/wt/.git", commonDir: "/wt/.git", toplevel: "/wt" };

test("a bare repository planted between a subdirectory and its checkout root invalidates cached facts", () => {
  const watched = watchedPaths("/wt/a/b", layout, [], []) ?? [];
  // Git would discover /wt/a as a repository once these appear, and read its config.
  for (const dir of ["/wt/a/b", "/wt/a"])
    for (const part of [".git", "HEAD", "objects", "refs", "config"])
      expect(watched).toContain(join(dir, part));
  // The checkout root is found through its own .git; its HEAD is the worktree's, not a marker.
  expect(watched).not.toContain("/wt/objects");
});

test("a directory outside its checkout root can't be stamped, so nothing is cached for it", () => {
  expect(watchedPaths("/elsewhere", layout, [], [])).toBeUndefined();
});

test("kept config sources don't hold the whole Git config listing in memory", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // A repository with many branches lists hundreds of KB of settings beside a few file names.
  // Below 1 MB, so Node decodes it into the JS heap rather than an external string. Node 24 (the
  // shipped runtime) keeps slices of it alive; newer V8 copies strings put in a Set.
  const filler = `branch.x.merge\n${"r".repeat(512 * 1024)}`;
  const listing = () =>
    Buffer.from(
      `global\0file:/home/u/.gitconfig\0user.name\nu\0local\0file:.git/config\0${filler}\0`,
    );
  gc();
  const before = process.memoryUsage().heapUsed;
  const kept = Array.from({ length: 80 }, () => listedSources(listing(), layout, "/home/u"));
  gc();
  const retained = process.memoryUsage().heapUsed - before;
  expect(kept[0]).toEqual(["/home/u/.gitconfig", "/wt/.git/config"]);
  // 80 listings of 512 KB each would be 40 MB if a kept path pinned its listing.
  expect(retained).toBeLessThan(8 * 1024 * 1024);
});
