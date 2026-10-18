import { join } from "node:path";
import { expect, test } from "vitest";
import { watchedPaths } from "./config-sources.ts";

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
