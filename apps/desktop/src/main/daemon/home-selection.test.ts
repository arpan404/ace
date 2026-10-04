import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDaemonHome } from "@ace/service/home";
import { desktopUserData } from "../user-data.ts";
import { DaemonRuntime } from "./runtime.ts";
import { loginService } from "./service.ts";
import { resolveTarget, type DaemonTarget } from "./target.ts";

/*
 * The desktop's daemon home and data folder, through its public seams, with the shared
 * resolver from `@ace/service` on temp user homes.
 */

let user: string;
const appData = () => join(user, "Library", "Application Support");

beforeEach(async () => {
  user = await mkdtemp(join(tmpdir(), "ace-desktop-home-"));
});
afterEach(async () => {
  await rm(user, { recursive: true, force: true });
});

/** The older ace 0.x layout found on a real machine: its launcher, daemon data and worktrees. */
async function legacyHome(): Promise<string> {
  const legacy = join(user, ".ace");
  await mkdir(join(legacy, "bin"), { recursive: true });
  await writeFile(
    join(legacy, "bin", "ace"),
    '#!/bin/sh\nexec node "$HOME/.ace/old/ace.js" "$@"\n',
    {
      mode: 0o755,
    },
  );
  await mkdir(join(legacy, "daemon"));
  await writeFile(join(legacy, "daemon", "state.sqlite"), "legacy");
  await mkdir(join(legacy, "worktrees"));
  return legacy;
}

/** Every entry under `root` with its size and modification time, to prove nothing changed. */
async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return Promise.all(
    entries.toSorted().map(async (entry) => {
      const info = await stat(join(root, entry));
      return `${entry} ${info.size} ${info.mtimeMs}`;
    }),
  );
}

function target(env: NodeJS.ProcessEnv): DaemonTarget {
  return resolveTarget(env, {
    packaged: true,
    daemonEntry: "/app/daemon/ace.mjs",
    readToken: () => "",
    platform: "darwin",
    homedir: user,
    resolveHome: resolveDaemonHome,
  });
}

describe("the desktop's daemon home and data folder", () => {
  it("selects the isolated home and its own data folder when ~/.ace is the legacy 0.x layout", async () => {
    await legacyHome();
    const chosen = target({});
    expect(chosen).toMatchObject({
      kind: "managed",
      home: join(user, ".ace-next"),
      isolated: true,
    });
    expect(desktopUserData({ explicit: undefined, target: chosen, appData: appData() })).toBe(
      join(appData(), "ace-next"),
    );
  });

  it("writes nothing under the legacy home, and never offers its 0.x service", async () => {
    const legacy = await legacyHome();
    const before = await snapshot(legacy);
    const chosen = target({});
    // A later launch keeps the isolated home the first one marked.
    expect(target({})).toEqual(chosen);
    expect(await snapshot(legacy)).toEqual(before);
    expect(loginService(legacy)).toBeUndefined();
    expect(chosen.kind === "managed" && loginService(chosen.home)).toBeUndefined();
  });

  it("keeps ~/.ace and the app's default data folder on a fresh machine", () => {
    const chosen = target({});
    expect(chosen).toMatchObject({ kind: "managed", home: join(user, ".ace"), isolated: false });
    expect(desktopUserData({ explicit: undefined, target: chosen, appData: appData() })).toBe(
      undefined,
    );
  });

  it("uses an explicit ACE_HOME and ACE_DESKTOP_USER_DATA over the defaults", async () => {
    await legacyHome();
    const explicit = join(user, "work", "ace-home");
    const chosen = target({ ACE_HOME: explicit });
    expect(chosen).toMatchObject({ kind: "managed", home: explicit, isolated: false });
    const data = join(user, "work", "electron");
    expect(desktopUserData({ explicit: data, target: target({}), appData: appData() })).toBe(data);
  });

  it("refuses an explicit ACE_HOME holding legacy data: nothing starts, and the app says why", async () => {
    const legacy = await legacyHome();
    await writeFile(join(legacy, "ace.db"), "legacy");
    const before = await snapshot(legacy);
    const spawned: unknown[] = [];
    const runtime = new DaemonRuntime({
      packaged: true,
      version: "0.0.0",
      resources: { entry: join(user, "unused.mjs") },
      env: { ACE_HOME: legacy, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
      platform: "darwin",
      spawnDaemon: (options) => {
        spawned.push(options);
        throw new Error("must not spawn");
      },
      log: () => {},
    });
    await runtime.start();
    expect(runtime.current()).toMatchObject({ state: "failed" });
    expect(runtime.current().message).toMatch(/Legacy ace data/);
    await expect(runtime.connection()).rejects.toThrow(/Legacy ace data/);
    expect(spawned).toEqual([]);
    expect(await snapshot(legacy)).toEqual(before);
  });
});
