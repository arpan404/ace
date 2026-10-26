import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { processIdentity, windowsTreeRuntime } from "@ace/provider-kit/process-identity";
import { ProcessInventory, windowsTreeRecorded } from "@ace/provider-kit/process-inventory";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { invoke } from "./cli-test-support.ts";
import { builtinSkillRecovery } from "./builtin-skill-roots.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { startDaemonCli, temporaryHome, type Cleanups } from "./daemon-launch-test-support.ts";
import {
  alive,
  crashedDaemon,
  endLater,
  runningThread,
  threadMentions,
  type Member,
} from "./daemon-crash-test-support.ts";

const windows = process.platform === "win32";

/** A journal row for a live process another program now owns under a reused PID. */
function journalReusedPid(dataDir: string, pid: number): void {
  const self = processIdentity(process.pid);
  new ProcessInventory(join(dataDir, "processes.sqlite")).close();
  const db = new DatabaseSync(join(dataDir, "processes.sqlite"));
  try {
    const entry = {
      pid,
      start: "1",
      uid: self?.uid,
      group: pid,
      ownerPid: pid,
      ownerStart: "1",
      name: "reused-pid",
      createdAt: 0,
    };
    db.prepare("INSERT INTO processes VALUES (?,?)").run(pid, JSON.stringify(entry));
  } finally {
    db.close();
  }
}

/** A real first run formats the home, so later starts treat it as their own. */
async function formattedHome(prefix: string, cleanups: Cleanups): Promise<string> {
  const home = await temporaryHome(prefix, cleanups);
  const first = startDaemonCli(home, cleanups);
  await first.ready;
  await stop(home);
  await first.exited;
  return home;
}

async function stop(home: string): Promise<void> {
  const result = await invoke(home, ["stop", "--json", "--timeout", "60s"]);
  expect(result.code, result.stderr).toBe(0);
}

const unverified = "Previous run's processes could not all be verified as stopped";

test.runIf(windows)(
  "Windows: daemon startup ends a recorded grandchild whose parent already exited, and leaves a reused PID alone",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await formattedHome("ace-win-recovery-", cleanups);
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    cleanups.push(() => void bystander.kill());
    const bystanderPid = z.number().int().positive().parse(bystander.pid);
    const original: Member = {
      pid: bystanderPid,
      start: z.string().parse(processIdentity(bystanderPid)?.start),
    };
    let members: readonly Member[] = [];
    endLater(cleanups, () => members);
    const crashed = await crashedDaemon(home, { grandchild: true, recorder: true, skills: false });
    members = crashed.all();
    journalReusedPid(home, bystanderPid);
    // The contained tree ended with the crashed daemon's job; the grandchild escaped it.
    await expect
      .poll(() => crashed.contained.some((member) => alive(member)), { timeout: 10_000 })
      .toBe(false);
    expect(alive(crashed.child)).toBe(true);

    const next = startDaemonCli(home, cleanups);
    await next.ready;
    // Startup recovery ended it before the daemon published readiness.
    expect(alive(crashed.child)).toBe(false);
    expect(alive(original)).toBe(true);
    expect((await daemonLogRecords(home)).map((record) => record.message)).not.toContain(
      unverified,
    );
    await stop(home);
    expect(await next.exited).toBe(0);
    expect(windowsTreeRecorded(join(home, "processes.sqlite"), crashed.leader)).toBe(false);
  },
  180_000,
);

test.runIf(windows)(
  "Windows: an orphan that cannot be proven the crashed run's is left running and on record, and its thread is told the run may still be running",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await formattedHome("ace-win-unproven-", cleanups);
    const thread = await runningThread(home, await temporaryHome("ace-win-work-", cleanups));
    let members: readonly Member[] = [];
    endLater(cleanups, () => members);
    // Nothing recorded the child: it names the dead leader's PID, which a stranger could reuse.
    const crashed = await crashedDaemon(home, {
      grandchild: false,
      recorder: false,
      skills: false,
    });
    members = crashed.all();
    await expect.poll(() => alive(crashed.leader), { timeout: 10_000 }).toBe(false);

    const next = startDaemonCli(home, cleanups);
    await next.ready;
    expect(alive(crashed.child)).toBe(true);
    expect((await daemonLogRecords(home)).map((record) => record.message)).toContain(unverified);
    await expect
      .poll(() => threadMentions(home, thread, "could not be verified as stopped"), {
        timeout: 30_000,
      })
      .toBe(true);
    expect(threadMentions(home, thread, "previous provider work stopped")).toBe(false);
    await stop(home);
    await next.exited;
    expect(windowsTreeRecorded(join(home, "processes.sqlite"), crashed.leader)).toBe(true);

    // Once it exits, the next start proves the tree gone and drops the record by itself.
    for (const member of members) windowsTreeRuntime.terminate(member);
    await expect.poll(() => alive(crashed.child), { timeout: 10_000 }).toBe(false);
    const healed = startDaemonCli(home, cleanups);
    await healed.ready;
    await stop(home);
    await healed.exited;
    expect(windowsTreeRecorded(join(home, "processes.sqlite"), crashed.leader)).toBe(false);
  },
  240_000,
);

test.runIf(windows)(
  "Windows: a skill projection stays while a recorded grandchild of its provider runs after a crash, and is reclaimed once recovery proves it gone",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const dataDir = await temporaryHome("ace-win-skill-crash-", cleanups);
    let members: readonly Member[] = [];
    endLater(cleanups, () => members);
    const crashed = await crashedDaemon(dataDir, {
      grandchild: true,
      recorder: true,
      skills: true,
    });
    members = crashed.all();
    const root = z.string().parse(crashed.root);
    const skill = join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md");
    // The leader ended with the crashed daemon and the middle exited; the grandchild runs.
    await expect.poll(() => alive(crashed.leader), { timeout: 10_000 }).toBe(false);
    expect(alive(crashed.child)).toBe(true);

    const errors: unknown[] = [];
    await (
      await builtinSkillRecovery(dataDir)
    )(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    expect(await readFile(skill, "utf8")).toContain("html_render");

    // Daemon startup order: process recovery ends the grandchild, then skills are reclaimed.
    const inventory = new ProcessInventory(join(dataDir, "processes.sqlite"));
    try {
      expect(inventory.recoverWindows()).toMatchObject({ killed: 1, unresolved: 0 });
      await expect.poll(() => alive(crashed.child), { timeout: 10_000 }).toBe(false);
      expect(inventory.recoverWindows()).toEqual({ removed: 1, killed: 0, unresolved: 0 });
    } finally {
      inventory.close();
    }
    await (
      await builtinSkillRecovery(dataDir)
    )(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
  180_000,
);
