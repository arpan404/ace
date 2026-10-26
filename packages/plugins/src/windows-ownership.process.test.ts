import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { PinnedDirectory } from "@ace/workspace";
import {
  materializeProjection,
  ownershipMarker,
  projectPlugins,
  removeProjection,
} from "./index.ts";

const win = test.runIf(process.platform === "win32");
async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const base = await mkdtemp(join(tmpdir(), "ace-plugin-owned-日本語-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  return base;
}

win("plugin projection creates reusable private ownership evidence", async ({ onTestFinished }) => {
  const base = await fixture(onTestFinished);
  const root = join(base, "projection-✓");
  const projection = projectPlugins("claude", [], { root });
  await materializeProjection(projection, { root });
  await materializeProjection(projection, { root });
  const pinned = PinnedDirectory.atBoundary(root);
  try {
    expect(pinned.readPrivateText(ownershipMarker.name, 64)).toBe(ownershipMarker.contents);
  } finally {
    pinned.closeSync();
  }
  expect(await readdir(join(root, "generated"))).toEqual([]);
  await removeProjection(root);
  await expect(readdir(join(root, "generated"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, ownershipMarker.name), "utf8")).toBe(ownershipMarker.contents);
});

win(
  "plugin projection refuses public marker bytes and unowned nonempty roots",
  async ({ onTestFinished }) => {
    const base = await fixture(onTestFinished);
    const publicRoot = join(base, "public");
    const unownedRoot = join(base, "unowned");
    await mkdir(publicRoot);
    await mkdir(unownedRoot);
    await writeFile(join(publicRoot, ownershipMarker.name), ownershipMarker.contents);
    await writeFile(join(unownedRoot, "keep.txt"), "user content");
    await expect(
      materializeProjection(projectPlugins("claude", [], { root: publicRoot }), {
        root: publicRoot,
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      materializeProjection(projectPlugins("claude", [], { root: unownedRoot }), {
        root: unownedRoot,
      }),
    ).rejects.toThrow("Refusing to adopt a nonempty directory");
    expect(await readdir(publicRoot)).toEqual([ownershipMarker.name]);
    expect(await readdir(unownedRoot)).toEqual(["keep.txt"]);
    expect(await readFile(join(unownedRoot, "keep.txt"), "utf8")).toBe("user content");
  },
);

win(
  "plugin projection refuses a junction ancestor before touching its target",
  async ({ onTestFinished }) => {
    const base = await fixture(onTestFinished);
    const outside = join(base, "outside");
    const link = join(base, "alias");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "outside content");
    await symlink(outside, link, "junction");
    const root = join(link, "nested");
    await expect(
      materializeProjection(projectPlugins("claude", [], { root }), { root }),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside content");
  },
);
