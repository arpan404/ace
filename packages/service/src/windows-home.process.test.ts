import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { HOME_FORMAT_FILE, HOME_FORMAT_VERSION, prepareDaemonHome } from "./home.ts";

const win = test.runIf(process.platform === "win32");

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const base = await mkdtemp(join(tmpdir(), "ace-windows-home-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  return join(base, "home");
}

win(
  "a new Windows data home is private at creation and reuses its format marker",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    expect(prepareDaemonHome(root)).toEqual({ state: "created", root });
    const directory = PinnedDirectory.atBoundary(root);
    try {
      directory.checkPrivate();
      const marker = await readFile(join(root, HOME_FORMAT_FILE), "utf8");
      expect(JSON.parse(marker)).toMatchObject({ format: `ace-v${HOME_FORMAT_VERSION}` });
      expect(prepareDaemonHome(root)).toEqual({ state: "reused", root });
      expect(directory.matchesBoundary(root)).toBe(true);
      expect(await readFile(join(root, HOME_FORMAT_FILE), "utf8")).toBe(marker);
    } finally {
      directory.closeSync();
    }
  },
);

win(
  "an existing public empty Windows home is refused before adoption",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    await mkdir(root);
    expect(() => prepareDaemonHome(root)).toThrow(
      /protected directory owned only by this Windows user/,
    );
    expect(await readdir(root)).toEqual([]);
  },
);

win(
  "a public Windows home with the current format is refused without changing its data",
  async ({ onTestFinished }) => {
    const root = await fixture(onTestFinished);
    await mkdir(root);
    const marker = JSON.stringify({
      format: `ace-v${HOME_FORMAT_VERSION}`,
      createdAt: "untouched",
    });
    await writeFile(join(root, HOME_FORMAT_FILE), marker);
    await writeFile(join(root, "sentinel"), "original data");
    expect(() => prepareDaemonHome(root)).toThrow(
      /protected directory owned only by this Windows user/,
    );
    expect((await readdir(root)).toSorted()).toEqual([HOME_FORMAT_FILE, "sentinel"].toSorted());
    expect(await readFile(join(root, HOME_FORMAT_FILE), "utf8")).toBe(marker);
    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("original data");
  },
);
