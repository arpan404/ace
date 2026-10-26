import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { OldAceRunningError, prepareDaemonHome, resolveDaemonHome } from "./home.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function userHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-old-ace-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The 0.x layout on real machines: launcher, an empty `daemon/`, and app data in `userdata/`. */
async function oldAceHome(home: string): Promise<string> {
  const root = join(home, ".ace");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "ace"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await mkdir(join(root, "daemon"));
  await mkdir(join(root, "userdata", "logs"), { recursive: true });
  await writeFile(join(root, "userdata", "state.sqlite"), "old state");
  await mkdir(join(root, "worktrees"));
  return root;
}

/** A stand-in for the running old ace: a real process holding `file` open until it is killed. */
async function holdOpen(file: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require('node:fs').openSync(${JSON.stringify(file)}, 'r'); console.log('open'); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };
  cleanups.push(stop);
  await once(child.stdout, "data");
  return { pid: child.pid ?? 0, stop };
}

// Linux reads /proc for open files; other hosts need lsof.
const canSeeOpeners =
  process.platform === "linux" || !spawnSync("lsof", ["-v"], { stdio: "ignore" }).error;

test.skipIf(!canSeeOpeners)(
  "a running old ace that still has its data open is not renamed until it quits",
  async () => {
    const home = await userHome();
    const root = await oldAceHome(home);
    const old = await holdOpen(join(root, "userdata", "state.sqlite"));

    expect(() => prepareDaemonHome(resolveDaemonHome(home))).toThrow(OldAceRunningError);
    expect(() => prepareDaemonHome(resolveDaemonHome(home))).toThrow(
      `An older ace (pid ${old.pid}) is still running and using ${root}. Quit the old ace first`,
    );
    expect((await readdir(home)).toSorted()).toEqual([".ace"]);
    expect((await readdir(root)).toSorted()).toEqual(["bin", "daemon", "userdata", "worktrees"]);

    await old.stop();
    expect(prepareDaemonHome(resolveDaemonHome(home))).toMatchObject({ state: "fresh" });
    expect((await readdir(home)).toSorted()).toEqual([".ace", ".ace-v0"]);
  },
);

test("an old ace's live pid file stops the fresh start, and a stale one does not", async () => {
  const home = await userHome();
  const root = await oldAceHome(home);
  const old = await holdOpen(join(root, "userdata", "logs"));
  await writeFile(join(root, "daemon", "server.pid"), `${old.pid}\n`);

  expect(() => prepareDaemonHome(resolveDaemonHome(home))).toThrow(OldAceRunningError);
  expect(await readdir(home)).toEqual([".ace"]);

  await old.stop();
  expect(prepareDaemonHome(resolveDaemonHome(home))).toMatchObject({
    state: "fresh",
    backup: join(home, ".ace-v0"),
  });
});
