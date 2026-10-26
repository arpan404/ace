import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath } from "./host-files.ts";
import { installNativeHost, installedNativeHosts, uninstallNativeHost } from "./install.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ace-user-browser-"));
  cleanups.push(dir);
  return dir;
}

test("install writes a host manifest only for browsers that have run, naming only ace's extension", async () => {
  const home = await temp();
  const dataDir = join(home, ".ace");
  const support = join(home, "Library/Application Support");
  await mkdir(join(support, "Google/Chrome"), { recursive: true });
  await mkdir(join(support, "BraveSoftware/Brave-Browser"), { recursive: true });
  const installed = await installNativeHost({
    platform: "darwin",
    home,
    dataDir,
    node: "/opt/node",
  });
  expect(installed.map((host) => host.browser).toSorted()).toEqual(["Brave", "Chrome"]);
  const manifestPath = join(
    support,
    "Google/Chrome/NativeMessagingHosts/dev.ace.user_browser.json",
  );
  expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
    name: "dev.ace.user_browser",
    description: expect.any(String),
    path: launcherPath(dataDir),
    type: "stdio",
    allowed_origins: [extensionOrigin],
  });
  const launcher = await readFile(launcherPath(dataDir), "utf8");
  expect(launcher).toMatch(/^#!\/bin\/sh\n/);
  expect(launcher).toContain(`'/opt/node'`);
  expect(launcher).toContain(`--data-dir '${dataDir}'`);
  expect((await stat(launcherPath(dataDir))).mode & 0o111).toBe(0o111);
  await expect(stat(join(support, "Microsoft Edge/NativeMessagingHosts"))).rejects.toThrow();
});

test("linux manifests follow XDG_CONFIG_HOME, and a test browser's profile directory can be added", async () => {
  const home = await temp();
  const config = join(home, "xdg");
  const extra = join(home, "profile/NativeMessagingHosts");
  await mkdir(join(config, "chromium"), { recursive: true });
  const installed = await installNativeHost({
    platform: "linux",
    home,
    dataDir: join(home, "data"),
    node: "/usr/bin/node",
    env: { XDG_CONFIG_HOME: config },
    extraDirs: [extra],
  });
  expect(installed.map((host) => host.manifestPath)).toEqual([
    join(config, "chromium/NativeMessagingHosts/dev.ace.user_browser.json"),
    join(extra, "dev.ace.user_browser.json"),
  ]);
});

test("uninstall removes this ace's manifests and launcher but leaves another data directory's", async () => {
  const home = await temp();
  await mkdir(join(home, ".config/google-chrome"), { recursive: true });
  const mine = join(home, "mine");
  const other = join(home, "other");
  await installNativeHost({ platform: "linux", home, dataDir: other, node: "/n" });
  await installNativeHost({ platform: "linux", home, dataDir: mine, node: "/n" });
  // The last install owns the shared manifest path.
  expect(await installedNativeHosts({ platform: "linux", home, dataDir: other })).toEqual([]);
  await uninstallNativeHost({ platform: "linux", home, dataDir: other });
  expect(await installedNativeHosts({ platform: "linux", home, dataDir: mine })).toHaveLength(1);
  await uninstallNativeHost({ platform: "linux", home, dataDir: mine });
  expect(await installedNativeHosts({ platform: "linux", home, dataDir: mine })).toEqual([]);
  await expect(stat(launcherPath(mine))).rejects.toThrow();
});
