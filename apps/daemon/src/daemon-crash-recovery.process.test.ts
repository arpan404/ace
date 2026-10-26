import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { invoke } from "./cli-test-support.ts";
import { builtinSkillRecovery } from "./builtin-skill-roots.ts";
import {
  daemonPackage,
  running,
  startDaemonCli,
  temporaryHome,
  type Cleanups,
} from "./daemon-launch-test-support.ts";

const windows = process.platform === "win32";
const Tree = z.object({ leader: z.number().int().positive(), child: z.number().int().positive() });
const Crashed = z.object({ contained: Tree, escaped: Tree, root: z.string().optional() });

// A provider leader that starts a detached child of its own, then reports both PIDs.
const leaderSource = [
  "const {spawn}=require('node:child_process');",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});",
  "console.log(JSON.stringify({leader:process.pid,child:child.pid}));",
  "setInterval(()=>{},1000);",
].join("");

/**
 * A daemon stand-in that journals two provider trees in `dataDir`, one in ace's Job Object and
 * one that escaped it, then is ended by TerminateProcess. With `skills`, the escaped provider
 * also holds a built-in skill projection lease.
 */
async function crashedDaemon(dataDir: string, skills: boolean) {
  const source = `
    import { observeProcessGroups, spawnSupervised } from "@ace/provider-kit/process";
    import { ProcessInventory } from "@ace/provider-kit/process-inventory";
    import { prepareBuiltinSkills } from "@ace/plugins";
    import { createBuiltinSkillRoot } from "./src/builtin-skill-roots.ts";
    import { builtinSkillProcessLease } from "./src/builtin-skill-processes.ts";
    const dataDir = ${JSON.stringify(dataDir)};
    observeProcessGroups(new ProcessInventory(dataDir + "/processes.sqlite"));
    const root = ${skills} ? await createBuiltinSkillRoot(dataDir) : undefined;
    if (root) await prepareBuiltinSkills("codex", root);
    const launch = (name, escaped) => new Promise((resolve) => {
      const child = spawnSupervised({
        command: process.execPath, args: ["-e", ${JSON.stringify(leaderSource)}], env: process.env, name,
        ...(escaped ? { windowsJobFactory: () => undefined } : {}),
        ...(escaped && root ? { lease: builtinSkillProcessLease(root) } : {}),
      });
      child.stdout.once("line", (line) => resolve(JSON.parse(line)));
    });
    const contained = await launch("contained-provider", false);
    const escaped = await launch("escaped-provider", true);
    console.log(JSON.stringify({ contained, escaped, root }));
    setInterval(() => {}, 1000);
  `;
  const daemon = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: daemonPackage,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const text = await new Promise<string>((resolve, reject) => {
    let output = "";
    daemon.once("error", reject);
    daemon.once("exit", (code) => reject(new Error(`Fixture daemon exited ${code}`)));
    daemon.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(output);
    });
  });
  const crashed = Crashed.parse(JSON.parse(text));
  const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  // TerminateProcess: no exit handler, finalizer or journal cleanup runs.
  daemon.kill();
  await exited;
  return crashed;
}

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

function killLater(cleanups: Cleanups, pids: number[]): void {
  cleanups.push(() => {
    for (const pid of pids) if (running(pid)) process.kill(pid);
  });
}

test.runIf(windows)(
  "Windows: daemon startup ends the escaped provider tree a crashed run left behind and never touches a reused PID",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-win-recovery-", cleanups);
    // A real first run formats the home, so the next start treats it as its own.
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    expect((await invoke(home, ["stop", "--json", "--timeout", "60s"])).code).toBe(0);
    await first.exited;

    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const bystanderPid = z.number().int().positive().parse(bystander.pid);
    cleanups.push(() => void bystander.kill());
    const crashed = await crashedDaemon(home, false);
    killLater(cleanups, [crashed.escaped.leader, crashed.escaped.child]);
    journalReusedPid(home, bystanderPid);
    // The contained tree ended with the crashed daemon's job; the escaped child did not.
    await expect
      .poll(() => running(crashed.contained.leader) || running(crashed.contained.child), {
        timeout: 10_000,
      })
      .toBe(false);
    expect(running(crashed.escaped.child)).toBe(true);

    const next = startDaemonCli(home, cleanups);
    await next.ready;
    // Startup recovery ran before the daemon published readiness.
    expect(running(crashed.escaped.child)).toBe(false);
    expect(running(bystanderPid)).toBe(true);
    expect((await invoke(home, ["stop", "--json", "--timeout", "60s"])).code).toBe(0);
    expect(await next.exited).toBe(0);
  },
  180_000,
);

test.runIf(windows)(
  "Windows: a skill projection stays while an escaped descendant of its provider runs after a crash, and is reclaimed once it exits",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const dataDir = await temporaryHome("ace-win-skill-crash-", cleanups);
    const crashed = await crashedDaemon(dataDir, true);
    killLater(cleanups, [crashed.escaped.leader, crashed.escaped.child]);
    const root = z.string().parse(crashed.root);
    const skill = join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md");
    // The leader ends with the crashed daemon; only its detached child still runs.
    await expect.poll(() => running(crashed.escaped.leader), { timeout: 10_000 }).toBe(false);
    expect(running(crashed.escaped.child)).toBe(true);

    const errors: unknown[] = [];
    await (
      await builtinSkillRecovery(dataDir)
    )(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    expect(await readFile(skill, "utf8")).toContain("html_render");

    process.kill(crashed.escaped.child);
    await expect.poll(() => running(crashed.escaped.child), { timeout: 10_000 }).toBe(false);
    await (
      await builtinSkillRecovery(dataDir)
    )(Promise.resolve(), (error) => errors.push(error));
    expect(errors).toEqual([]);
    await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
  180_000,
);
