import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  canonicalDownloadFolder,
  daemonDownloadFolder,
  systemDownloadsFolder,
  type DownloadsHost,
} from "./download-folder.ts";

const home = async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-download-home-")));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, "Downloads"));
  return path;
};

describe("the daemon's downloads folder setting", () => {
  it("keeps the default when empty and stores a home-relative folder as its real path", async () => {
    const root = await home();
    expect(await canonicalDownloadFolder("  ", root)).toBe("");
    expect(await canonicalDownloadFolder("~/Downloads", root)).toBe(join(root, "Downloads"));
  });

  it("refuses a relative path, a missing folder, a file and a folder it can't write", async () => {
    const root = await home();
    await expect(canonicalDownloadFolder("Downloads", root)).rejects.toThrow(/full path/);
    await expect(canonicalDownloadFolder(join(root, "missing"), root)).rejects.toThrow(
      /doesn't exist/,
    );
    await writeFile(join(root, "file.txt"), "x");
    await expect(canonicalDownloadFolder(join(root, "file.txt"), root)).rejects.toThrow(
      /isn't a folder/,
    );
    const locked = join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    onTestFinished(() => chmod(locked, 0o700));
    if (process.getuid?.() !== 0)
      await expect(canonicalDownloadFolder(locked, root)).rejects.toThrow(/can't save/);
  });
});

const host = (
  platform: NodeJS.Platform,
  root: string,
  files: Record<string, string> = {},
  env: Record<string, string> = {},
): DownloadsHost => ({
  platform,
  home: root,
  env,
  readFile: async (path) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
});

describe("this machine's Downloads folder, the default for ace's Chrome", () => {
  it("is ~/Downloads on macOS and Windows", async () => {
    expect(await systemDownloadsFolder(host("darwin", "/Users/me"))).toBe("/Users/me/Downloads");
    expect(await systemDownloadsFolder(host("win32", "/Users/me"))).toBe("/Users/me/Downloads");
  });

  it("follows XDG_DOWNLOAD_DIR on Linux, else ~/Downloads", async () => {
    const dirs =
      '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n';
    expect(
      await systemDownloadsFolder(
        host("linux", "/home/me", { "/home/me/.config/user-dirs.dirs": dirs }),
      ),
    ).toBe("/home/me/Téléchargements");
    expect(
      await systemDownloadsFolder(
        host(
          "linux",
          "/home/me",
          { "/cfg/user-dirs.dirs": 'XDG_DOWNLOAD_DIR="/data/dl"' },
          { XDG_CONFIG_HOME: "/cfg" },
        ),
      ),
    ).toBe("/data/dl");
    expect(await systemDownloadsFolder(host("linux", "/home/me"))).toBe("/home/me/Downloads");
  });

  it("is used when no folder is chosen, and a missing one leaves downloads with the thread", async () => {
    const root = await home();
    const mac = host("darwin", root);
    expect(await daemonDownloadFolder("", mac)).toBe(join(root, "Downloads"));
    const chosen = join(root, "Elsewhere");
    await mkdir(chosen);
    expect(await daemonDownloadFolder(chosen, mac)).toBe(chosen);
    await rm(join(root, "Downloads"), { recursive: true });
    expect(await daemonDownloadFolder("", mac)).toBeUndefined();
  });
});
