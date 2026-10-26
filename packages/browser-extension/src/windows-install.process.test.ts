import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { extensionOrigin } from "./extension-id.ts";
import { userBrowserHostName } from "@ace/protocol";
import { installNativeHost, installedNativeHosts, uninstallNativeHost } from "./install.ts";
import type { WindowsRegistry, RegistryKey } from "./windows-registry.ts";
import { windowsLauncher } from "./windows-native-host.ts";

const registryName = (key: RegistryKey) => `${key.view}:${key.key}`;
function registry(): WindowsRegistry {
  const values = new Map<string, string>();
  return {
    async read(keys) {
      return keys.map((key) => values.get(registryName(key)));
    },
    async write(keys, value) {
      for (const key of keys) values.set(registryName(key), value);
    },
    async remove(keys, expected) {
      for (const key of keys)
        if (values.get(registryName(key)) === expected) values.delete(registryName(key));
    },
  };
}

test.runIf(process.platform === "win32")(
  "the Windows native host launcher preserves paths and browser arguments",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-native-launch-"));
    try {
      const dataDir = join(home, "data 雪 %ACE_UNSET% ! &");
      await mkdir(dataDir);
      const entry = join(dataDir, "host.cjs");
      await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const launcher = join(home, "native host.cmd");
      await writeFile(launcher, windowsLauncher({ node: process.execPath, entry, dataDir }));
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
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Windows installs native hosts for browsers that have run and preserves another ace's registration", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-windows-host-"));
  try {
    for (const path of ["Google/Chrome/User Data", "Microsoft/Edge/User Data"])
      await mkdir(join(home, "AppData/Local", path), { recursive: true });
    const shared = {
      platform: "win32" as const,
      home,
      node: process.execPath,
      registry: registry(),
    };
    const mine = { ...shared, dataDir: join(home, "mine") };
    const other = { ...shared, dataDir: join(home, "other") };
    const installed = await installNativeHost(mine);
    expect(installed.map((host) => host.browser)).toEqual(["Chrome", "Edge"]);
    const manifestPath = installed[0]?.manifestPath;
    if (!manifestPath) throw new Error("Missing native host manifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({ allowed_origins: [extensionOrigin], type: "stdio" });
    expect(
      await readFile(join(mine.dataDir, "user-browser", "ace-native-host.cmd"), "utf8"),
    ).toContain("setlocal DisableDelayedExpansion\r\n");
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows registry write failures make native host installation fail", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-windows-host-error-"));
  try {
    await mkdir(join(home, "AppData/Local/Chromium/User Data"), { recursive: true });
    const denied: WindowsRegistry = {
      ...registry(),
      async write() {
        throw new Error("Access denied");
      },
    };
    await expect(
      installNativeHost({
        platform: "win32",
        home,
        dataDir: join(home, "data"),
        node: process.execPath,
        registry: denied,
      }),
    ).rejects.toThrow("Access denied");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows uninstall clears its stale registration after the manifest and browser profile disappear", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-windows-host-stale-"));
  const profile = join(home, "AppData/Local/Google/Chrome/User Data");
  const port = registry();
  try {
    await mkdir(profile, { recursive: true });
    const options = {
      platform: "win32" as const,
      home,
      dataDir: join(home, "data"),
      node: process.execPath,
      registry: port,
    };
    const installed = await installNativeHost(options);
    const manifestPath = installed[0]?.manifestPath;
    if (!manifestPath) throw new Error("Missing installed host");
    const key = `Software\\Google\\Chrome\\NativeMessagingHosts\\${userBrowserHostName}`;
    const keys: RegistryKey[] = [
      { key, view: 32 },
      { key, view: 64 },
    ];
    expect(await port.read(keys)).toEqual([manifestPath, manifestPath]);
    await rm(manifestPath);
    await rm(profile, { recursive: true });
    await uninstallNativeHost(options);
    expect(await port.read(keys)).toEqual([undefined, undefined]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
