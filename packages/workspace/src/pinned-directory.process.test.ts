import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PinnedDirectory } from "./index.ts";

test("publication follows its pinned inode when a pathname is replaced with a legacy-home link", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-pinned-publication-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "legacy"));
  await writeFile(join(root, "legacy/ace.db"), "leave legacy alone");
  const parent = PinnedDirectory.atBoundary(root),
    next = parent.mkdir("next");
  try {
    await rename(join(root, "next"), join(root, "detached"));
    await symlink(join(root, "legacy"), join(root, "next"));
    next.publish("marker.json", '{"complete":true}\n');
    expect(await readFile(join(root, "detached/marker.json"), "utf8")).toBe('{"complete":true}\n');
    expect(await readdir(join(root, "legacy"))).toEqual(["ace.db"]);
    expect(await readFile(join(root, "legacy/ace.db"), "utf8")).toBe("leave legacy alone");
  } finally {
    next.closeSync();
    parent.closeSync();
  }
});

test("bounded regular-file reads refuse links, directories and oversized files", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-pinned-read-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "regular"), "safe", { mode: 0o600 });
  await writeFile(join(root, "large"), "x".repeat(17));
  await symlink("regular", join(root, "link"));
  await mkdir(join(root, "directory"));
  const directory = PinnedDirectory.atBoundary(root);
  try {
    expect(directory.readText("regular", 16, directory.stat().uid)).toBe("safe");
    for (const name of ["link", "directory", "large"])
      expect(() => directory.readText(name, 16)).toThrow();
    expect(directory.empty()).toBe(false);
    expect(directory.empty()).toBe(false);
  } finally {
    directory.closeSync();
  }
});
