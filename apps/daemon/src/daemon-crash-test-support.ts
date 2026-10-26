import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { Agent, AgentId, RunId, type ThreadId } from "@ace/protocol";
import { processIdentity, windowsTreeRuntime } from "@ace/provider-kit/process-identity";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createDevThread } from "./commands.ts";
import { daemonPackage, type Cleanups } from "./daemon-launch-test-support.ts";
import { Store } from "./store.ts";

/** A process by creation identity: a reused PID is someone else and is never touched. */
export type Member = { pid: number; start: string };
export function alive(member: Member): boolean {
  return processIdentity(member.pid)?.start === member.start;
}
function identify(pid: number): Member {
  const found = processIdentity(pid);
  if (!found) throw new Error(`Process ${pid} exited before it could be identified`);
  return { pid, start: found.start };
}
/** Teardown ends only the processes the test started, checked against their creation time. */
export function endLater(cleanups: Cleanups, members: () => readonly Member[]): void {
  cleanups.push(() => {
    for (const member of members()) windowsTreeRuntime.terminate(member);
  });
}

const Started = z.object({
  contained: z.object({ leader: z.number(), child: z.number() }),
  escaped: z.object({
    leader: z.number(),
    middle: z.number().optional(),
    child: z.number(),
  }),
  root: z.string().optional(),
});

/** A detached child that runs until it is ended; prints its PID. */
const child =
  "const {spawn}=require('node:child_process');" +
  "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});";
// Leader -> detached child.
const direct = `${child}console.log(JSON.stringify({leader:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
// Leader -> detached middle -> detached child; the middle exits after `MIDDLE_MS`.
const middle = `${child}console.log(c.pid);setTimeout(()=>process.exit(0),Number(process.env.MIDDLE_MS));`;
const nested =
  "const {spawn}=require('node:child_process');" +
  `const m=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','pipe','ignore'],detached:true});` +
  "m.stdout.once('data',(d)=>console.log(JSON.stringify({leader:process.pid,middle:m.pid,child:Number(String(d).trim())})));" +
  "setInterval(()=>{},1000);";

export interface CrashPlan {
  /** The escaped leader starts a middle process that exits, leaving a grandchild. */
  grandchild: boolean;
  /** The running daemon records proven descendants; off, nothing past the leader is known. */
  recorder: boolean;
  skills: boolean;
}

/**
 * A daemon stand-in that journals two provider trees in `dataDir`, one in ace's Job Object and
 * one that escaped it, waits for the plan's evidence, then is ended by TerminateProcess.
 */
export async function crashedDaemon(dataDir: string, plan: CrashPlan) {
  const source = `
    import { observeProcessGroups, spawnSupervised } from "@ace/provider-kit/process";
    import { ProcessInventory, inventoryRuntime } from "@ace/provider-kit/process-inventory";
    import { prepareBuiltinSkills } from "@ace/plugins";
    import { createBuiltinSkillRoot } from "./src/builtin-skill-roots.ts";
    import { builtinSkillProcessLease } from "./src/builtin-skill-processes.ts";
    const dataDir = ${JSON.stringify(dataDir)};
    const runtime = ${plan.recorder} ? inventoryRuntime : { ...inventoryRuntime, windowsEvery: () => () => {} };
    observeProcessGroups(new ProcessInventory(dataDir + "/processes.sqlite", runtime));
    const root = ${plan.skills} ? await createBuiltinSkillRoot(dataDir) : undefined;
    if (root) await prepareBuiltinSkills("codex", root);
    const launch = (name, escaped, source) => new Promise((resolve) => {
      const child = spawnSupervised({
        command: process.execPath, args: ["-e", source], env: { ...process.env, MIDDLE_MS: "4000" }, name,
        ...(escaped ? { windowsJobFactory: () => undefined } : {}),
        ...(escaped && root ? { lease: builtinSkillProcessLease(root) } : {}),
      });
      child.stdout.once("line", (line) => resolve(JSON.parse(line)));
    });
    const contained = await launch("contained-provider", false, ${JSON.stringify(direct)});
    const escaped = await launch("escaped-provider", true, ${JSON.stringify(plan.grandchild ? nested : direct)});
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
  const started = Started.parse(JSON.parse(text));
  const members = {
    contained: [identify(started.contained.leader), identify(started.contained.child)],
    leader: identify(started.escaped.leader),
    middle: started.escaped.middle === undefined ? undefined : identify(started.escaped.middle),
    child: identify(started.escaped.child),
  };
  const journal = join(dataDir, "processes.sqlite");
  if (plan.recorder)
    await expect.poll(() => journaled(journal, members.child.pid), { timeout: 15_000 }).toBe(true);
  const middleMember = members.middle;
  if (middleMember) await expect.poll(() => alive(middleMember), { timeout: 15_000 }).toBe(false);
  const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
  // TerminateProcess: no exit handler, finalizer or journal cleanup runs.
  daemon.kill();
  await exited;
  const all = [...members.contained, members.leader, members.child];
  if (members.middle) all.push(members.middle);
  return { ...members, root: started.root, all: () => all };
}

export function journaled(journal: string, pid: number): boolean {
  const db = new DatabaseSync(journal, { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM processes WHERE pid=?").get(pid) !== undefined;
  } finally {
    db.close();
  }
}

/** A thread whose provider run was still active when the daemon went away. */
export async function runningThread(home: string, workspace: string): Promise<ThreadId> {
  const store = new Store(join(home, "events.sqlite"), (error) => {
    throw error;
  });
  try {
    const thread = createDevThread(store, store.createWorkspace(workspace, "Crash workspace"));
    const root = AgentId.parse("root");
    store.appendEvents(
      thread.id,
      [
        {
          type: "agent.created",
          agent: Agent.parse({
            id: root,
            threadId: thread.id,
            parentId: null,
            origin: "root",
            fidelity: "full",
            native: { provider: "codex" },
            cwd: workspace,
            status: { state: "idle" },
            createdAt: 10,
          }),
        },
        { type: "agent.status", agentId: root, status: { state: "working", activity: "thinking" } },
        {
          type: "run.started",
          run: {
            id: RunId.parse("crashed-run"),
            threadId: thread.id,
            agentId: root,
            trigger: "user",
            state: "active",
            startedAt: 20,
          },
        },
      ],
      20,
    );
    return thread.id;
  } finally {
    await store.close();
  }
}

/** Whether the thread's stored history mentions `text`; readable while a daemon runs. */
export function threadMentions(home: string, thread: ThreadId, text: string): boolean {
  const db = new DatabaseSync(join(home, "events.sqlite"), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT 1 FROM events WHERE thread_id=? AND instr(payload, ?) > 0")
        .get(thread, text) !== undefined
    );
  } finally {
    db.close();
  }
}
