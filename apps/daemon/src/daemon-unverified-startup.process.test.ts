// Real edges: the daemon CLI process, its socket and a process group a crashed run left behind.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { invoke } from "./cli-test-support.ts";
import { startDaemonCli, temporaryHome, type Cleanups } from "./daemon-launch-test-support.ts";

/** A detached group whose leader has exited while a child in it runs on: its leader's pid. */
async function strandedGroup(cleanups: Cleanups) {
  const child = "setInterval(()=>{},1000)";
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});console.log(c.pid);c.unref();`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const childPid = z.coerce
    .number()
    .int()
    .positive()
    .parse(
      await new Promise<string>((resolve) =>
        leader.stdout?.once("data", (data: Buffer) => resolve(String(data).trim())),
      ),
    );
  await new Promise((resolve) => leader.once("exit", resolve));
  cleanups.push(async () => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return { leader: z.number().int().positive().parse(leader.pid), child: childPid };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "a group the last run left whose leader is gone never stops the daemon from starting",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-unverified-start-", cleanups);
    // A first run formats the home, so the next start treats its process record as its own.
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    expect((await invoke(home, ["stop", "--json", "--timeout", "60s"])).code).toBe(0);
    await first.exited;
    const group = await strandedGroup(cleanups);
    // The crashed run recorded the group's leader; the leader is gone, its child is not.
    const self = processIdentity(process.pid);
    new ProcessInventory(join(home, "processes.sqlite")).close();
    const db = new DatabaseSync(join(home, "processes.sqlite"));
    db.prepare("INSERT INTO processes VALUES (?,?)").run(
      group.leader,
      JSON.stringify({
        pid: group.leader,
        start: "1",
        uid: self?.uid,
        group: group.leader,
        ownerPid: group.leader,
        ownerStart: "1",
        name: "crashed-provider",
        createdAt: 0,
      }),
    );
    db.close();
    const daemon = startDaemonCli(home, cleanups);
    await daemon.ready;
    const listed = await invoke(home, ["project", "list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);

    // Not provably the run's: left alone, never a reason to refuse startup.
    expect(alive(group.child)).toBe(true);
  },
  120_000,
);
