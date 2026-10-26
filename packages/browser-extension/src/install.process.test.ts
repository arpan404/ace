import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { extensionOrigin } from "./extension-id.ts";
import { NativeMessageDecoder } from "./framing.ts";
import { hostCredentialPath } from "./host-files.ts";
import {
  hostRegistry,
  installNativeHost,
  installedNativeHosts,
  uninstallNativeHost,
  type NativeHostRegistry,
} from "./install.ts";
import { windowsLauncherScript } from "./native-hosts.ts";

// Windows native host registration; every case runs only on Windows.
const windows = test.runIf(process.platform === "win32");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ace-user-browser-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const run = promisify(execFile);
const Manifest = z.object({ path: z.string() });
const readManifest = async (path: string) =>
  Manifest.parse(JSON.parse(await readFile(path, "utf8")));

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

/** The real HKCU through reg.exe, under a throwaway key instead of the browsers' own keys. */
function scratchRegistry(): NativeHostRegistry {
  const root = `Software\\Ace\\Tests\\${randomUUID()}`;
  cleanups.push(() =>
    run("reg.exe", ["delete", `HKCU\\${root}`, "/f"], { windowsHide: true }).catch(() => {}),
  );
  const scoped = (keys: readonly string[]) => keys.map((key) => `${root}\\${key}`);
  return {
    read: (keys) => hostRegistry.read(scoped(keys)),
    write: (keys, value) => hostRegistry.write(scoped(keys), value),
    remove: (keys, expected) => hostRegistry.remove(scoped(keys), expected),
  };
}

windows(
  "Windows registers hosts for browsers that have run and preserves another ace's registration",
  async () => {
    const home = await temp();
    for (const path of ["Google/Chrome/User Data", "Microsoft/Edge/User Data"])
      await mkdir(join(home, "AppData/Local", path), { recursive: true });
    const shared = { platform: "win32" as const, home, node: "C:\\node.exe" };
    const registry = memoryRegistry();
    const mine = { ...shared, registry, dataDir: join(home, "mine") };
    const other = { ...shared, registry, dataDir: join(home, "other") };
    const installed = await installNativeHost(mine);
    expect(installed.map((host) => host.browser)).toEqual(["Chrome", "Edge"]);
    const manifestPath = installed[0]?.manifestPath;
    if (!manifestPath) throw new Error("Missing native host manifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    expect(manifest).toMatchObject({ allowed_origins: [extensionOrigin], type: "stdio" });
    const { path: launcher } = Manifest.parse(manifest);
    expect(launcher.startsWith(join(home, "AppData", "Local", "ace", "native-hosts"))).toBe(true);
    expect(await readFile(launcher, "utf8")).toContain("setlocal DisableDelayedExpansion\r\n");
    expect(await installedNativeHosts(mine)).toEqual(installed);
    await installNativeHost(other);
    expect(await installedNativeHosts(mine)).toEqual([]);
    await uninstallNativeHost(mine);
    await expect(stat(launcher)).rejects.toThrow();
    expect((await installedNativeHosts(other)).map((host) => host.browser)).toEqual([
      "Chrome",
      "Edge",
    ]);
    await uninstallNativeHost(other);
    expect(await installedNativeHosts(other)).toEqual([]);
  },
);

windows("Windows registry write failures make native host installation fail", async () => {
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

windows(
  "Windows uninstall clears its stale registration after the manifest and browser profile disappear",
  async () => {
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
  },
);

windows(
  "Windows refuses extra profile directories, which only the registry can register",
  async () => {
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
  },
);

windows(
  "Windows refuses a launcher path cmd.exe would rewrite instead of registering a broken host",
  async () => {
    const home = await temp();
    await mkdir(join(home, "AppData/Local/Google/Chrome/User Data"), { recursive: true });
    const registry = memoryRegistry();
    const options = {
      platform: "win32" as const,
      home,
      dataDir: join(home, "data"),
      node: process.execPath,
      env: { LOCALAPPDATA: join(home, "Local %TEMP%") },
      registry,
    };
    await expect(installNativeHost(options)).rejects.toThrow(/% or !/);
    expect(await installedNativeHosts(options)).toEqual([]);
  },
);

/** A stand-in daemon socket that welcomes the host and records its hello. */
async function fakeDaemon(token: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const hellos: unknown[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; token?: string };
      if (message.type !== "hello") return;
      hellos.push(message);
      if (message.token === token) socket.send(JSON.stringify({ type: "welcome" }));
    }),
  );
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hellos };
}

windows(
  "Chrome starts the installed host through cmd.exe even when the data directory holds % and !",
  { timeout: 60_000 },
  async () => {
    const home = await temp();
    await mkdir(join(home, "AppData/Local/Google/Chrome/User Data"), { recursive: true });
    const dataDir = join(home, "ace%USERNAME%data 雪 !PATH! &");
    const token = "a".repeat(64);
    const daemon = await fakeDaemon(token);
    await mkdir(join(dataDir, "user-browser"), { recursive: true });
    await writeFile(join(dataDir, "daemon-endpoint"), daemon.origin);
    await writeFile(
      hostCredentialPath(dataDir),
      JSON.stringify({
        device: {
          id: "host-device",
          name: "ace for Chrome",
          scopes: ["user-browser"],
          createdAt: 1,
          lastSeenAt: 1,
          revokedAt: null,
        },
        token,
      }),
    );
    const registry = memoryRegistry();
    const options = { platform: "win32" as const, home, dataDir, node: process.execPath, registry };
    await installNativeHost(options);
    const [registered] = await registry.read([
      "Software\\Google\\Chrome\\NativeMessagingHosts\\dev.ace.user_browser",
    ]);
    if (!registered) throw new Error("Chrome's key was not registered");
    const { path: launcher } = await readManifest(registered);
    // Exactly Chrome's command line; Chrome redirects the pipes inside it, here they are stdio.
    const child = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `""${launcher}" ${extensionOrigin} --parent-window=0"`],
      { windowsVerbatimArguments: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    cleanups.push(async () => {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    });
    const decoder = new NativeMessageDecoder(1024 * 1024);
    const messages: unknown[] = [];
    child.stdout.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const connected = () =>
      messages.some((message) => (message as { state?: string }).state === "connected");
    for (let attempt = 0; attempt < 300 && !connected() && child.exitCode === null; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connected(), stderr).toBe(true);
    expect(daemon.hellos).toEqual([expect.objectContaining({ token })]);
    child.stdin.end();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);
  },
);

windows(
  "the Windows launcher keeps a trailing backslash, restores the code page and returns Node's exit code",
  { timeout: 30_000 },
  async () => {
    const home = await temp();
    const entry = join(home, "host.cjs");
    await writeFile(
      entry,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(7);\n",
    );
    const launcher = join(home, "launcher.cmd");
    const dataDir = `${home}\\`;
    await writeFile(launcher, windowsLauncherScript({ node: process.execPath, entry, dataDir }));
    const { stdout } = await run(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `"chcp 437 >nul & "${launcher}" chrome-extension://x/ & chcp"`],
      { windowsVerbatimArguments: true, windowsHide: true, timeout: 10_000, encoding: "utf8" },
    );
    const [args, codePage] = stdout.trim().split(/\r?\n/);
    expect(JSON.parse(args ?? "")).toEqual(["--data-dir", dataDir, "chrome-extension://x/"]);
    expect(codePage).toMatch(/437/);
    const exit = await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `""${launcher}""`], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      timeout: 10_000,
    }).then(
      () => 0,
      (error: { code?: unknown }) => error.code,
    );
    expect(exit).toBe(7);
  },
);

windows(
  "concurrent installs and uninstalls of two data directories leave the survivor registered",
  { timeout: 120_000 },
  async () => {
    const home = await temp();
    await mkdir(join(home, "AppData/Local/Google/Chrome/User Data"), { recursive: true });
    const registry = scratchRegistry();
    const shared = { platform: "win32" as const, home, node: process.execPath, registry };
    const leaving = { ...shared, dataDir: join(home, "leaving") };
    const staying = { ...shared, dataDir: join(home, "staying") };
    for (let round = 0; round < 4; round++) {
      await installNativeHost(leaving);
      await Promise.all([uninstallNativeHost(leaving), installNativeHost(staying)]);
      expect((await installedNativeHosts(staying)).map((host) => host.browser)).toEqual(["Chrome"]);
    }
  },
);

windows("a registry lock left by an exited or stuck ace never blocks installation", async () => {
  const home = await temp();
  await mkdir(join(home, "AppData/Local/Google/Chrome/User Data"), { recursive: true });
  const options = {
    platform: "win32" as const,
    home,
    dataDir: join(home, "data"),
    node: process.execPath,
    registry: memoryRegistry(),
  };
  const lock = join(home, "AppData/Local/ace/native-hosts/registry.lock");
  await mkdir(join(lock, ".."), { recursive: true });
  const exited = spawn(process.execPath, ["-e", ""]);
  await once(exited, "exit");
  await writeFile(lock, `${exited.pid} gone`);
  expect(await installNativeHost(options)).toHaveLength(1);
  // A live owner that has held the lock far longer than any registry update.
  await writeFile(lock, `${process.pid} stuck`);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, old, old);
  await uninstallNativeHost(options);
  expect(await installedNativeHosts(options)).toEqual([]);
  await expect(stat(lock)).rejects.toThrow();
});

windows(
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
      await run("reg.exe", ["delete", `HKCU\\${key}`, "/f"], { windowsHide: true }).catch(() => {});
    }
  },
);
