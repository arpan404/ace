import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_FORMAT_FILE, prepareDaemonHome, resolveDaemonHome } from "@ace/service/home";
import type { LogData } from "../log/desktop-log.ts";
import { cliShimMarker } from "../os/cli-shim.ts";
import { installCliShim } from "../os/cli-shim-install.ts";
import { checkUserData, desktopUserData, legacyFolders } from "../user-data.ts";
import { logFreshStart } from "./fresh-start-log.ts";
import { resolveTarget, type DaemonTarget } from "./target.ts";

/*
 * The desktop's daemon home and data folder, through its public seams, with the shared
 * resolver and home preparation from `@ace/service` on temp user homes.
 */

let user: string;
const appData = () => join(user, "Library", "Application Support");
const oldShim = '#!/bin/sh\nexec node "$HOME/.ace/old/ace.js" "$@"\n';

beforeEach(async () => {
  user = await realpath(await mkdtemp(join(tmpdir(), "ace-desktop-home-")));
});
afterEach(async () => {
  await rm(user, { recursive: true, force: true });
});

/** The pre-format `~/.ace` found on real machines: its launcher, daemon data and worktrees. */
async function legacyHome(): Promise<string> {
  const legacy = join(user, ".ace");
  await mkdir(join(legacy, "bin"), { recursive: true });
  await writeFile(join(legacy, "bin", "ace"), oldShim, { mode: 0o755 });
  await mkdir(join(legacy, "daemon"));
  await writeFile(join(legacy, "daemon", "state.sqlite"), "legacy");
  await mkdir(join(legacy, "worktrees"));
  return legacy;
}

/** An installed app whose bundled runtime and daemon CLI the shim points at. */
async function installedApp(): Promise<{ node: string; entry: string }> {
  const resources = join(user, "Applications", "ace.app", "Contents", "Resources");
  await mkdir(join(resources, "runtime", "bin"), { recursive: true });
  await mkdir(join(resources, "daemon"), { recursive: true });
  const node = join(resources, "runtime", "bin", "node");
  await writeFile(node, "#!/bin/sh\n");
  await chmod(node, 0o755);
  const entry = join(resources, "daemon", "ace.mjs");
  await writeFile(entry, "// daemon CLI\n");
  return { node, entry };
}

function target(env: NodeJS.ProcessEnv): DaemonTarget {
  return resolveTarget(env, {
    packaged: true,
    daemonEntry: "/app/daemon/ace.mjs",
    readToken: () => "",
    platform: "darwin",
    homedir: user,
    resolveHome: resolveDaemonHome,
    prepareHome(home) {
      const prepared = prepareDaemonHome(home);
      return prepared.state === "fresh"
        ? { backup: prepared.backup, previousFormat: prepared.previousFormat }
        : undefined;
    },
  });
}

describe("the desktop's daemon home and data folder", () => {
  it("uses ~/.ace for the daemon on a fresh machine, and creates it in the current format", async () => {
    expect(target({})).toEqual({
      kind: "managed",
      home: join(user, ".ace"),
      entry: "/app/daemon/ace.mjs",
    });
    expect(await readdir(join(user, ".ace"))).toEqual([HOME_FORMAT_FILE]);
    // A later launch reuses it as it is.
    expect(target({})).toEqual(target({}));
    expect(await readdir(user)).toEqual([".ace"]);
  });

  it("the CLI shim and logs land in the new home after a fresh start", async () => {
    await legacyHome();
    const app = await installedApp();
    // Resolved once at launch, before the app writes anything (index.ts).
    const chosen = target({});
    if (chosen.kind !== "managed") throw new Error(`Expected a managed target: ${chosen.kind}`);
    const backup = join(user, ".ace-v0");
    expect(chosen.fresh).toEqual({ backup, previousFormat: "ace-v0" });

    const shim = await installCliShim({
      dataHome: chosen.home,
      platform: "darwin",
      ...app,
      loginPath: async () => join(user, ".ace", "bin"),
    });
    const records: { message: string; data: LogData | undefined }[] = [];
    await logFreshStart(
      chosen,
      (_level, message, data) => records.push({ message, data }),
      new Date(),
    );

    expect(shim).toMatchObject({ state: "created", file: join(user, ".ace", "bin", "ace") });
    expect(await readFile(join(user, ".ace", "bin", "ace"), "utf8")).toContain(cliShimMarker);
    // The old launcher went with the backup, untouched, and nothing new was written there.
    expect(await readFile(join(backup, "bin", "ace"), "utf8")).toBe(oldShim);
    expect((await readdir(backup)).toSorted()).toEqual(
      ["BACKUP-README.txt", "bin", "daemon", "worktrees"].toSorted(),
    );
    expect(records).toEqual([
      {
        message: "Started with a fresh data home; the old data was backed up",
        data: expect.objectContaining({
          backup,
          previousFormat: "ace-v0",
          bytes: expect.any(Number),
        }),
      },
    ]);
  });

  it("uses an explicit ACE_HOME and ACE_DESKTOP_USER_DATA over the defaults", async () => {
    const explicit = join(user, "work", "ace-home");
    expect(target({ ACE_HOME: explicit })).toMatchObject({ kind: "managed", home: explicit });
    expect(await readdir(explicit)).toEqual([HOME_FORMAT_FILE]);
    const data = join(user, "work", "electron");
    expect(desktopUserData({ explicit: data, appData: appData() })).toBe(data);
  });

  it("refuses a home of newer data without moving it, and keeps its own data folder apart", async () => {
    const home = join(user, ".ace");
    await mkdir(home);
    const marker = JSON.stringify({ format: "ace-v999", createdAt: "2030-01-01T00:00:00.000Z" });
    await writeFile(join(home, HOME_FORMAT_FILE), marker);

    expect(target({})).toMatchObject({ kind: "refused", reason: expect.stringMatching(/newer/) });

    expect(await readdir(user)).toEqual([".ace"]);
    expect(await readFile(join(home, HOME_FORMAT_FILE), "utf8")).toBe(marker);
    const data = desktopUserData({ explicit: undefined, appData: appData() });
    expect(checkUserData(data, legacyFolders({ appData: appData(), homedir: user }))).toBe(
      undefined,
    );
  });
});
