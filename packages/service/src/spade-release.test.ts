import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pointer } from "./files.ts";
import { installSpadeBinary, installedSpadeVersion, spadeReleases } from "./spade-release.ts";

async function temp(onTestFinished: (fn: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-spade-release-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, ".ace");
  await mkdir(home);
  const binary = async (text: string) => {
    const path = join(root, `spade-server-${text}`);
    await writeFile(path, text, { mode: 0o755 });
    return path;
  };
  return { root, home, binary };
}

test.skipIf(process.platform === "win32")(
  "installing copies the binary into its version folder and points current at it",
  async ({ onTestFinished }) => {
    const { home, binary } = await temp(onTestFinished);
    expect(await installedSpadeVersion(home)).toBeUndefined();
    await installSpadeBinary(home, await binary("one"), "0.4.0");
    expect(await installedSpadeVersion(home)).toBe("0.4.0");
    expect(await pointer(join(spadeReleases(home), "current"))).toBe("0.4.0");
    expect(await readFile(join(home, "releases/spade/current/spade-server"), "utf8")).toBe("one");
  },
);

test("a newer install keeps the one before it and prunes older ones", async ({
  onTestFinished,
}) => {
  const { home, binary } = await temp(onTestFinished);
  await installSpadeBinary(home, await binary("one"), "0.4.0");
  await installSpadeBinary(home, await binary("two"), "0.4.1");
  await installSpadeBinary(home, await binary("three"), "0.5.0");
  expect(await installedSpadeVersion(home)).toBe("0.5.0");
  const names = (await readdir(spadeReleases(home))).filter((name) => name !== "current");
  expect(names.toSorted()).toEqual(["0.4.1", "0.5.0"]);
});

test.skipIf(process.platform === "win32")(
  "a source that is a link is refused",
  async ({ onTestFinished }) => {
    const { root, home, binary } = await temp(onTestFinished);
    const link = join(root, "linked-spade");
    await symlink(await binary("one"), link);
    await expect(installSpadeBinary(home, link, "0.4.0")).rejects.toThrow(/not a plain file/);
    expect(await installedSpadeVersion(home)).toBeUndefined();
  },
);

test.skipIf(process.platform === "win32")(
  "a version folder replaced by a link is refused, never written through",
  async ({ onTestFinished }) => {
    const { root, home, binary } = await temp(onTestFinished);
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(spadeReleases(home), { recursive: true });
    await symlink(elsewhere, join(spadeReleases(home), "0.4.0"));
    await expect(installSpadeBinary(home, await binary("one"), "0.4.0")).rejects.toThrow(
      /not a plain folder/,
    );
    expect(await readdir(elsewhere)).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "a current pointer that leaves Spade's releases is refused",
  async ({ onTestFinished }) => {
    const { home, binary } = await temp(onTestFinished);
    await installSpadeBinary(home, await binary("one"), "0.4.0");
    const current = join(spadeReleases(home), "current");
    await rm(current);
    await symlink("../../../elsewhere", current);
    await expect(installedSpadeVersion(home)).rejects.toThrow(/Refusing/);
  },
);
