import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { claimHome, prepareDaemonHome } from "./home.ts";
import { freshStartSpade, type SyncRunner } from "./spade-fresh-start.ts";
import { spadeServicePlan } from "./spade-plan.ts";

const posix = process.platform !== "win32";

/**
 * A home in an older format (no marker, so a fresh start sets it aside) holding Spade's binary
 * and data, with Spade's launchd agent registered for it (or for `registeredFor`).
 */
async function setup(
  onTestFinished: (fn: () => Promise<void>) => void,
  options: { registeredFor?: string; binary?: boolean; registered?: boolean } = {},
) {
  const user = await mkdtemp(join(tmpdir(), "ace-spade-fresh-"));
  onTestFinished(() => rm(user, { recursive: true, force: true }));
  const root = join(user, ".ace");
  await mkdir(join(root, "spade"), { recursive: true });
  await writeFile(join(root, "spade/spade.sqlite"), "Spade's data");
  if (options.binary !== false) {
    await mkdir(join(root, "releases/spade/0.4.0"), { recursive: true });
    await writeFile(join(root, "releases/spade/0.4.0/spade-server"), "spade", { mode: 0o755 });
    await symlink("0.4.0", join(root, "releases/spade/current"));
  }
  const planFor = (home: string) => spadeServicePlan(home, "darwin", { userHome: user, uid: 501 });
  if (options.registered !== false) {
    const registered = planFor(options.registeredFor ?? root);
    await mkdir(dirname(registered.file), { recursive: true });
    await writeFile(registered.file, registered.content);
  }
  /** What launchd was asked, and whether Spade's binary was still in the home at the time. */
  const calls: string[] = [];
  const run: SyncRunner = (file, args) => {
    const inPlace = existsSync(join(root, "releases/spade/current/spade-server"));
    calls.push(`${file} ${args[0]} (binary ${inPlace ? "in the home" : "absent"})`);
    return { code: 0, stderr: "" };
  };
  const prepare = () =>
    prepareDaemonHome(root, {
      now: () => new Date("2026-11-11T12:00:00.000Z"),
      claim: (home) => claimHome(home),
      spade: freshStartSpade(planFor, run),
    });
  return { root, calls, prepare };
}

test.runIf(posix)(
  "a fresh start stops Spade before moving the home and starts it on the binary it carried over",
  async ({ onTestFinished }) => {
    const { root, calls, prepare } = await setup(onTestFinished);
    const prepared = prepare();
    if (prepared.state !== "fresh")
      throw new Error(`expected a fresh start, got ${prepared.state}`);
    expect(calls).toEqual([
      "launchctl bootout (binary in the home)",
      "launchctl bootstrap (binary in the home)",
    ]);
    // Spade's program follows the home; its data stays in the backup with the rest.
    expect(await readFile(join(root, "releases/spade/current/spade-server"), "utf8")).toBe("spade");
    expect(existsSync(join(root, "spade/spade.sqlite"))).toBe(false);
    expect(await readFile(join(prepared.backup, "spade/spade.sqlite"), "utf8")).toBe(
      "Spade's data",
    );
  },
);

test.runIf(posix)(
  "a fresh start leaves an unregistered Spade alone",
  async ({ onTestFinished }) => {
    const { calls, prepare } = await setup(onTestFinished, { registered: false });
    expect(prepare().state).toBe("fresh");
    expect(calls).toEqual([]);
  },
);

test.runIf(posix)(
  "a Spade registered for another ACE_HOME isn't stopped by this home's fresh start",
  async ({ onTestFinished }) => {
    const { calls, prepare } = await setup(onTestFinished, { registeredFor: "/elsewhere/.ace" });
    expect(prepare().state).toBe("fresh");
    expect(calls).toEqual([]);
  },
);

test.runIf(posix)(
  "a registered Spade without a binary to carry stays stopped after the fresh start",
  async ({ onTestFinished }) => {
    const { calls, prepare } = await setup(onTestFinished, { binary: false });
    expect(prepare().state).toBe("fresh");
    expect(calls).toEqual(["launchctl bootout (binary absent)"]);
  },
);
