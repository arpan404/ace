import { z } from "zod";
import { AgentId, ThreadId, type MachineCommandJobsResult } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { clip } from "../agent-control/watch-view.ts";
import { MachineFailure } from "./transport.ts";

/** Rows in the calling thread for command jobs on other machines (`machine_jobs`). */
export const remoteJobPrefix = "ace-machine-job:";
/** How long past its own timeout a job that can't be read is still held. */
const graceMs = 10 * 60 * 1000;
/** Jobs read in one call to their machine. */
const batch = 16;

export interface RemoteJobsDeps {
  store: Store;
  engine(): Engine | undefined;
  now(): number;
  schedule(ms: number, run: () => void): () => void;
  pollMs: number;
  /** The jobs' states on their machine, as the calling thread there sees them. */
  poll(
    machine: string,
    threadId: ThreadId,
    jobIds: readonly string[],
  ): Promise<MachineCommandJobsResult["jobs"]>;
  /** Stops one job on its machine (`command_stop`). */
  stop(machine: string, threadId: ThreadId, agentId: AgentId, jobId: string): Promise<void>;
  /**
   * The device this machine is paired with `machine` as, or undefined once that pairing is gone.
   * Throws when the pairings can't be read, which is never taken as gone.
   */
  device(machine: string): string | undefined;
  label(machine: string): string;
  log(message: string, fields: Record<string, unknown>): void;
}

const Row = z.object({
  machine: z.string(),
  job_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  deadline: z.number(),
  stopping: z.number(),
});
type Row = z.infer<typeof Row>;
type Ending = "completed" | "failed" | "stopped";

/** Refusals that mean the machine no longer runs anything for this one (ADR 0105 kill switch). */
function closedToUs(error: unknown): boolean {
  return (
    error instanceof MachineFailure &&
    error.kind === "refused" &&
    (error.refusal === "machine_forbidden" ||
      error.refusal === "machine_opted_out" ||
      error.refusal === "unauthorized" ||
      error.refusal === "not_found")
  );
}

/**
 * Background command jobs agents here started on other machines (ADR 0105). Each holds a
 * stoppable row in its calling thread, so the thread never reads done while the job runs there.
 * The ledger is durable, so a restart keeps holding and polling them. A row ends when its machine
 * says the job ended or doesn't have it, when the person stops it, when that machine stops
 * serving this one's commands or the pairing is gone, or long after the job's own timeout.
 * A machine that can't be reached keeps its jobs held until then, never done early.
 */
export class RemoteJobs {
  private deps: RemoteJobsDeps;
  private cancelTimer: (() => void) | undefined;
  private polling = false;
  private closed = false;
  constructor(deps: RemoteJobsDeps) {
    this.deps = deps;
    this.arm();
  }
  close(): void {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  /** A job an agent here just started there; its row opens at once. */
  add(job: {
    machine: string;
    jobId: string;
    threadId: ThreadId;
    agentId: AgentId;
    command: string;
    timeoutSeconds: number;
  }): void {
    const engine = this.deps.engine();
    if (!engine) return;
    const now = this.deps.now();
    this.deps.store.atomic(() => {
      this.deps.store
        .statement(
          `INSERT OR IGNORE INTO machine_jobs (machine, job_id, thread_id, agent_id, deadline, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          job.machine,
          job.jobId,
          job.threadId,
          job.agentId,
          now + job.timeoutSeconds * 1000 + graceMs,
          now,
        );
      engine.externalHold(job.threadId, job.agentId, this.key(job.machine, job.jobId), {
        title: clip(`${job.command} on ${this.deps.label(job.machine)}`, 200),
      });
    });
    this.arm();
  }
  /** The person stopped a row (`ace-machine-job:<machine>/<job>`): the job is stopped there. */
  stop(task: string): void {
    const at = task.indexOf("/");
    if (at < 0) return;
    const row = this.row(task.slice(0, at), task.slice(at + 1));
    if (!row) return;
    this.deps.store
      .statement("UPDATE machine_jobs SET stopping=1 WHERE machine=? AND job_id=?")
      .run(row.machine, row.job_id);
    void this.stopThere({ ...row, stopping: 1 });
  }
  private key(machine: string, jobId: string): string {
    return `${remoteJobPrefix}${machine}/${jobId}`;
  }
  private row(machine: string, jobId: string): Row | undefined {
    const row = this.deps.store
      .statement("SELECT * FROM machine_jobs WHERE machine=? AND job_id=?")
      .get(machine, jobId);
    return row ? Row.parse(row) : undefined;
  }
  private async stopThere(row: Row): Promise<void> {
    try {
      await this.deps.stop(
        row.machine,
        ThreadId.parse(row.thread_id),
        AgentId.parse(row.agent_id),
        row.job_id,
      );
      this.settle(row, "stopped");
    } catch (error) {
      // The job is unknown there or that machine closed to us: nothing runs any more.
      if (closedToUs(error)) this.settle(row, "stopped");
      // Otherwise it stays held and the next poll asks again.
    }
  }
  private arm(): void {
    if (this.closed || this.cancelTimer || this.polling) return;
    const any = this.deps.store.statement("SELECT 1 FROM machine_jobs LIMIT 1").get();
    if (!any) return;
    this.cancelTimer = this.deps.schedule(this.deps.pollMs, () => {
      this.cancelTimer = undefined;
      void this.poll();
    });
  }
  private async poll(): Promise<void> {
    if (this.closed) return;
    this.polling = true;
    try {
      const rows = this.deps.store
        .statement("SELECT * FROM machine_jobs ORDER BY machine, thread_id, job_id")
        .all()
        .map((row) => Row.parse(row));
      const groups = new Map<string, Row[]>();
      for (const row of rows) {
        const key = JSON.stringify([row.machine, row.thread_id]);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const group of groups.values())
        for (let i = 0; i < group.length; i += batch) await this.check(group.slice(i, i + batch));
    } catch (error) {
      this.deps.log("Remote command jobs not read", { error: String(error) });
    } finally {
      this.polling = false;
      this.arm();
    }
  }
  private async check(rows: Row[]): Promise<void> {
    const [first] = rows;
    if (!first) return;
    const now = this.deps.now();
    const thread = this.deps.store.getThread(ThreadId.parse(first.thread_id));
    let paired: string | undefined;
    try {
      paired = this.deps.device(first.machine);
    } catch {
      return; // The pairings can't be read now; that is never taken as gone.
    }
    const live: Row[] = [];
    for (const row of rows) {
      // The calling thread was deleted, the pairing is gone, or the job is long past its own
      // timeout: nothing will ever read it, so it lets go of the thread.
      if (!thread || thread.deletedAt !== undefined || paired === undefined)
        this.settle(row, "failed");
      else if (now > row.deadline) this.settle(row, "failed");
      else live.push(row);
    }
    if (live.length === 0) return;
    for (const row of live) if (row.stopping === 1) await this.stopThere(row);
    const asked = live.filter((row) => this.row(row.machine, row.job_id));
    if (asked.length === 0) return;
    let states: MachineCommandJobsResult["jobs"];
    try {
      states = await this.deps.poll(
        first.machine,
        ThreadId.parse(first.thread_id),
        asked.map((row) => row.job_id),
      );
    } catch (error) {
      // Commands closed to this machine there end every job it ran (the kill switch).
      if (closedToUs(error)) for (const row of asked) this.settle(row, "stopped");
      return;
    }
    for (const row of asked) {
      const state = states.find((entry) => entry.jobId === row.job_id)?.state;
      if (state === "ended" || state === "unknown")
        this.settle(row, row.stopping === 1 ? "stopped" : "completed");
    }
  }
  /** Ends the row and forgets the job. A deleted thread has nowhere to record it. */
  private settle(row: Row, ending: Ending): void {
    this.deps.store
      .statement("DELETE FROM machine_jobs WHERE machine=? AND job_id=?")
      .run(row.machine, row.job_id);
    const threadId = ThreadId.parse(row.thread_id);
    const thread = this.deps.store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined) return;
    try {
      this.deps
        .engine()
        ?.externalHold(threadId, AgentId.parse(row.agent_id), this.key(row.machine, row.job_id), {
          status: ending,
        });
    } catch (error) {
      this.deps.log("Remote command job row not ended", { error: String(error) });
    }
  }
}
