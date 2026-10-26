import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { extensionOrigin } from "./extension-id.ts";
import { launcherPath } from "./host-files.ts";
import {
  hostRegistry,
  installNativeHost,
  installedNativeHosts,
  uninstallNativeHost,
  type NativeHostRegistry,
} from "./install.ts";
import { windowsLauncherScript } from "./native-hosts.ts";

// Windows native host registration. The in-memory registry cases run everywhere; the
// launcher and real HKCU cases run only on Windows.
const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ace-user-browser-"));
  cleanups.push(dir);
  return dir;
}

/** An in-memory HKCU that keeps values per key, like the real one. */
function memoryRegistry(): NativeHostRegistry {
  const values = new Map<string, string>();
  return {
    async read(keys) {
      return keys.map((key) => values.get(key));
    },
    async write(keys, value) {
      for (const key of keys) values.set(key, value);
    },
    async remove(keys, expected) {
      for (const key of keys) if (values.get(key) === expected) values.delete(key);
    },
  };
}

test("Windows registers hosts for browsers that have run and preserves another ace's registration", async () => {
  const home = await temp();
  for (const path of ["Google/Chrome/User Data", "Microsoft/Edge/User Data"])
    await mkdir(join(home, "AppData/Local", path), { recursive: true });
  const shared = {
    platform: "win32" as const,
    home,
    node: "C:\\node.exe",
    registry: memoryRegistry(),
  };
  const mine = { ...shared, dataDir: join(home, "mine") };
  const other = { ...shared, dataDir: join(home, "other") };
  const installed = await installNativeHost(mine);
  expect(installed.map((host) => host.browser)).toEqual(["Chrome", "Edge"]);
  const manifestPath = installed[0]?.manifestPath;
  if (!manifestPath) throw new Error("Missing native host manifest");
  expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
    path: launcherPath(mine.dataDir, "win32"),
    allowed_origins: [extensionOrigin],
    type: "stdio",
  });
  expect(await readFile(launcherPath(mine.dataDir, "win32"), "utf8")).toContain(
    "setlocal DisableDelayedExpansion\r\n",
  );
  expect(await installedNativeHosts(mine)).toEqual(installed);
  await installNativeHost(other);
  expect(await installedNativeHosts(mine)).toEqual([]);
  await uninstallNativeHost(mine);
  expect((await installedNativeHosts(other)).map((host) => host.browser)).toEqual([
    "Chrome",
    "Edge",
  ]);
  await uninstallNativeHost(other);
  expect(await installedNativeHosts(other)).toEqual([]);
});

test("Windows registry write failures make native host installation fail", async () => {
  const home = await temp();
  await mkdir(join(home, "AppData/Local/Chromium/User Data"), { recursive: true });
  const denied: NativeHostRegistry = {
    ...memoryRegistry(),
    async write() {
      throw new Error("Access denied");
    },
  };
  await expect(
    installNativeHost({
      platform: "win32",
      home,
      dataDir: join(home, "data"),
      node: "C:\\node.exe",
      registry: denied,
    }),
  ).rejects.toThrow("Access denied");
});

test("Windows uninstall clears its stale registration after the manifest and browser profile disappear", async () => {
  const home = await temp();
  const profile = join(home, "AppData/Local/Google/Chrome/User Data");
  const registry = memoryRegistry();
  await mkdir(profile, { recursive: true });
  const options = {
    platform: "win32" as const,
    home,
    dataDir: join(home, "data"),
    node: "C:\\node.exe",
    registry,
  };
  const manifestPath = (await installNativeHost(options))[0]?.manifestPath;
  if (!manifestPath) throw new Error("Missing installed host");
  const key = "Software\\Google\\Chrome\\NativeMessagingHosts\\dev.ace.user_browser";
  expect(await registry.read([key])).toEqual([manifestPath]);
  await rm(manifestPath);
  await rm(profile, { recursive: true });
  await uninstallNativeHost(options);
  expect(await registry.read([key])).toEqual([undefined]);
});

test("Windows refuses extra profile directories, which only the registry can register", async () => {
  const home = await temp();
  await expect(
    installNativeHost({
      platform: "win32",
      home,
      dataDir: home,
      node: "node",
      extraDirs: [join(home, "profile")],
      registry: memoryRegistry(),
    }),
  ).rejects.toThrow(/registry/);
});

test.runIf(process.platform === "win32")(
  "the Windows launcher preserves paths and browser arguments through cmd.exe",
  { timeout: 30_000 },
  async () => {
    const home = await temp();
    const dataDir = join(home, "data 雪 %ACE_UNSET% ! &");
    await mkdir(dataDir);
    const entry = join(dataDir, "host.cjs");
    await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = join(home, "native host.cmd");
    await writeFile(launcher, windowsLauncherScript({ node: process.execPath, entry, dataDir }));
    const command = `""${launcher}" "chrome-extension://test/" "--parent-window=0""`;
    const { stdout } = await promisify(execFile)(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 65_536,
        encoding: "utf8",
      },
    );
    expect(JSON.parse(stdout)).toEqual([
      "--data-dir",
      dataDir,
      "chrome-extension://test/",
      "--parent-window=0",
    ]);
  },
);

test.runIf(process.platform === "win32")(
  "the real HKCU registry round-trips Unicode and removes only its own values",
  { timeout: 60_000 },
  async () => {
    const key = `Software\\Ace\\Tests\\${randomUUID()}`;
    const value = "C:\\Users\\owned 雪\\ace host.json";
    try {
      expect(await hostRegistry.read([key])).toEqual([undefined]);
      await hostRegistry.write([key], value);
      expect(await hostRegistry.read([key])).toEqual([value]);
      await hostRegistry.remove([key], "C:\\another-installation.json");
      expect(await hostRegistry.read([key])).toEqual([value]);
      await hostRegistry.remove([key], value);
      expect(await hostRegistry.read([key])).toEqual([undefined]);
    } finally {
      // Only this fixture's UUID key, never a browser's real registration.
      await promisify(execFile)("reg.exe", ["delete", `HKCU\\${key}`, "/f"], {
        windowsHide: true,
      }).catch(() => {});
    }
  },
);
