import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { processIdentity, windowsTreeRuntime } from "./process-identity.ts";
import { ProcessInventory } from "./process-inventory.ts";
import { DatabaseSync } from "./sqlite.ts";

const Pids = z.object({ leader: z.number().int().positive(), child: z.number().int().positive() });
type Member = { pid: number; start: string };

/** Identity, not PID: a reused PID is another process and must never be touched. */
function alive(member: Member): boolean {
  return processIdentity(member.pid)?.start === member.start;
}
function identify(pid: number): Member {
  const found = processIdentity(pid);
  if (!found) throw new Error(`Process ${pid} exited before it could be identified`);
  return { pid, start: found.start };
}
function endAll(members: readonly Member[]): void {
  for (const member of members) windowsTreeRuntime.terminate(member);
}

/**
 * A daemon stand-in that journals one supervised leader, which starts a detached child of its
 * own, then reports both PIDs. Node's own job ends the leader with the daemon, but the detached
 * child survives unless ace's job holds it; `contained: false` stands in for an escaped tree.
 */
async function crashedDaemon(path: string, contained: boolean, recorder = true) {
  const leader = [
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});",
    "console.log(JSON.stringify({leader:process.pid,child:child.pid}));",
    "setInterval(()=>{},1000);",
  ].join("");
  const manager: ChildProcess = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {observeProcessGroups,spawnSupervised} from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};
    import {ProcessInventory, inventoryRuntime} from ${JSON.stringify(new URL("./process-inventory.ts", import.meta.url).href)};
    const inventory = new ProcessInventory(${JSON.stringify(path)}${recorder ? "" : ", {...inventoryRuntime, windowsEvery: () => () => {}}"});
    observeProcessGroups(inventory);
    const child = spawnSupervised({command:process.execPath,args:['-e',${JSON.stringify(leader)}],env:process.env,name:'synthetic-provider'${contained ? "" : ",windowsJobFactory:()=>undefined"}});
    child.stdout.once('line',(line)=>console.log(line));
  `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const text = await new Promise<string>((resolve, reject) => {
    manager.once("error", reject);
    manager.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString()));
  });
  const pids = Pids.parse(JSON.parse(text));
  const members = { leader: identify(pids.leader), child: identify(pids.child) };
  // The running daemon proves and records the child while its parent is alive.
  if (recorder)
    await expect.poll(() => journaled(path, pids.child), { timeout: 10_000 }).toBe(true);
  // TerminateProcess, as a crash: no exit handler runs.
  manager.kill("SIGKILL");
  await new Promise<void>((resolve) => manager.once("exit", () => resolve()));
  return members;
}

function journaled(path: string, pid: number): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM processes WHERE pid=?").get(pid) !== undefined;
  } finally {
    db.close();
  }
}

function recover(path: string) {
  const inventory = new ProcessInventory(path);
  try {
    return { result: inventory.recover(), left: inventory.list().length };
  } finally {
    inventory.close();
  }
}

describe.runIf(process.platform === "win32")("Windows restart recovery", () => {
  test("a crash whose job already ended the tree leaves a journal that restart clears", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-journal-contained-"));
    const path = join(home, "processes.sqlite");
    try {
      const pids = await crashedDaemon(path, true);
      // Closing the crashed daemon's last job handle ends the whole tree.
      await expect
        .poll(() => alive(pids.leader) || alive(pids.child), { timeout: 10_000 })
        .toBe(false);
      expect(recover(path)).toEqual({ result: { removed: 1, killed: 0 }, left: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("restart ends the orphaned child of a recorded tree that escaped its job", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-journal-escaped-"));
    const path = join(home, "processes.sqlite");
    let pids: { leader: Member; child: Member } | undefined;
    try {
      pids = await crashedDaemon(path, false);
      const { leader, child } = pids;
      await expect.poll(() => alive(leader), { timeout: 10_000 }).toBe(false);
      expect(alive(child)).toBe(true);
      // The leader's record and its recorded child stay as evidence.
      expect(recover(path)).toEqual({ result: { removed: 0, killed: 1 }, left: 2 });
      await expect.poll(() => alive(child), { timeout: 10_000 }).toBe(false);
      // The evidence stays until a later recovery proves the tree is gone.
      expect(recover(path)).toEqual({ result: { removed: 1, killed: 0 }, left: 0 });
    } finally {
      if (pids) endAll([pids.leader, pids.child]);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an orphan the crashed daemon never recorded is left running and keeps its tree on record", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-journal-unproven-"));
    const path = join(home, "processes.sqlite");
    let pids: { leader: Member; child: Member } | undefined;
    try {
      pids = await crashedDaemon(path, false, false);
      const { leader, child } = pids;
      await expect.poll(() => alive(leader), { timeout: 10_000 }).toBe(false);
      // The child names a dead PID: it may be the leader's, or a later reuser's.
      const inventory = new ProcessInventory(path);
      try {
        expect(inventory.recoverWindows()).toEqual({ removed: 0, killed: 0, unresolved: 1 });
        expect(inventory.list().map((entry) => entry.pid)).toEqual([leader.pid]);
      } finally {
        inventory.close();
      }
      expect(alive(child)).toBe(true);
    } finally {
      if (pids) endAll([pids.leader, pids.child]);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("restart drops a stale entry whose PID now belongs to an unrelated process", async () => {
    const home = mkdtempSync(join(tmpdir(), "ace-journal-reused-"));
    const path = join(home, "processes.sqlite");
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      const pid = z.number().int().positive().parse(bystander.pid);
      const original = identify(pid);
      const self = processIdentity(process.pid);
      new ProcessInventory(path).close();
      const db = new DatabaseSync(path);
      try {
        // Recorded with an older creation time by a daemon that no longer exists.
        const entry = {
          pid,
          start: "1",
          uid: self?.uid,
          group: pid,
          ownerPid: pid,
          ownerStart: "1",
          name: "stale",
          createdAt: 0,
        };
        db.prepare("INSERT INTO processes VALUES (?,?)").run(pid, JSON.stringify(entry));
      } finally {
        db.close();
      }
      expect(recover(path)).toEqual({ result: { removed: 1, killed: 0 }, left: 0 });
      expect(alive(original)).toBe(true);
    } finally {
      bystander.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });
});
