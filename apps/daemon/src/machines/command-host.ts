import { z } from "zod";
import type { MachineToolResult } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { clip } from "../agent-control/watch-view.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { CapabilityHost } from "./capability-hosts.ts";
import type { GuestSession, GuestSessions } from "./guest-sessions.ts";
import {
  backgroundTailBytes,
  CommandJobArgs,
  CommandOutputArgs,
  CommandRunArgs,
  commandEnv,
  foregroundTailBytes,
  inside,
  outcomeLine,
  placeCwd,
  timeoutFor,
  type CommandOutcome,
} from "./command-rules.ts";
import {
  runCommand,
  type CommandClock,
  type CommandSpawner,
  type RunningCommand,
} from "./command-process.ts";

export interface CommandHostDeps {
  store: Store;
  engine(): Engine | undefined;
  guests: GuestSessions;
  /** A project's checkout and its worktrees; refuses a project this machine doesn't have. */
  roots(project: string | undefined): string[];
  /** The real path of a folder, or undefined when there is none there. */
  folder(path: string): Promise<string | undefined>;
  /** How this machine's shell runs one command line. */
  shell(command: string): { command: string; args: string[] };
  /** The environment a local agent's shell has here. */
  env(): NodeJS.ProcessEnv;
  spawn: CommandSpawner;
  clock: CommandClock;
  newId(): string;
  log(message: string, fields: Record<string, unknown>): void;
}

interface Job {
  id: string;
  session: GuestSession;
  command: string;
  cwd: string;
  run: RunningCommand;
  outcome?: CommandOutcome;
  controller: AbortController;
}

/** Background jobs one calling thread may run at once, and finished ones kept to read. */
const runningPerSession = 8;
const keptPerSession = 16;
const Origin = z.object({ origin_host: z.string(), origin_thread: z.string() });

const text = (value: string): MachineToolResult["content"][number] => ({
  type: "text",
  text: value,
});
function invalid(error: z.ZodError): TargetRefusal {
  const issue = error.issues[0];
  const where = issue?.path.join(".") || "arguments";
  return new TargetRefusal("invalid", clip(`${where}: ${issue?.message ?? "invalid"}`, 300));
}

/**
 * Commands for agents on other machines (ADR 0105): allowed when on, no prompt per command,
 * confined to this machine's projects, each one logged and recorded in the calling thread's
 * guest session. Background jobs belong to that session: they hold a stoppable row there and
 * end, with every process they started, when the person stops them or turns Commands down.
 */
export class CommandHost implements CapabilityHost {
  private deps: CommandHostDeps;
  private jobs = new Map<string, Job>();
  constructor(deps: CommandHostDeps) {
    this.deps = deps;
  }
  available(): boolean {
    return true;
  }
  /** A shell command can't be proven read-only, so every command tool acts. */
  readOnly(): boolean {
    return false;
  }
  async call(
    session: GuestSession,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MachineToolResult> {
    switch (tool) {
      case "command_run":
        return this.run(session, args, signal);
      case "command_status":
        return this.status(this.job(session, args));
      case "command_output":
        return this.output(session, args);
      case "command_stop":
        return this.stop(this.job(session, args));
      default:
        throw new TargetRefusal("invalid", "Unknown command tool.");
    }
  }
  private async run(session: GuestSession, raw: Record<string, unknown>, signal: AbortSignal) {
    const parsed = CommandRunArgs.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error);
    const args = parsed.data;
    const timeout = timeoutFor(args);
    if (typeof timeout !== "number") throw new TargetRefusal("invalid", timeout.refused);
    const cwd = await this.place(args.project, args.cwd);
    const spec = {
      ...this.deps.shell(args.command),
      cwd,
      env: commandEnv(this.deps.env(), args.env),
    };
    const limits = {
      timeoutMs: timeout * 1000,
      tailBytes: args.background ? backgroundTailBytes : foregroundTailBytes,
    };
    if (args.background) return this.background(session, args.command, spec, limits);
    signal.throwIfAborted();
    const run = runCommand(this.deps.spawn, this.deps.clock, spec, limits);
    const key = `ace-command:${this.deps.newId()}`;
    this.record(session, key, args.command, cwd, run.startedAt);
    const stop = () => run.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const outcome = await run.done;
      this.finished(session, key, args.command, cwd, run, outcome);
      return this.result(outcome, cwd, run);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  /** A folder inside the project (or one of its worktrees), links resolved. */
  private async place(project: string | undefined, cwd: string | undefined): Promise<string> {
    const roots = this.deps.roots(project);
    const placed = placeCwd(roots, cwd);
    const outside = "cwd must stay inside the project: name a folder in it, relative to its root.";
    if (!placed) throw new TargetRefusal("invalid", outside);
    const real = await this.deps.folder(placed.path);
    if (!real) throw new TargetRefusal("invalid", "No such folder in the project.");
    const realRoots = await Promise.all(roots.map((root) => this.deps.folder(root)));
    if (!realRoots.some((root) => root !== undefined && inside(root, real)))
      throw new TargetRefusal("invalid", outside);
    return real;
  }
  private async background(
    session: GuestSession,
    command: string,
    spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
    limits: { timeoutMs: number; tailBytes: number },
  ): Promise<MachineToolResult> {
    const mine = [...this.jobs.values()].filter((job) => job.session.threadId === session.threadId);
    if (mine.filter((job) => !job.outcome).length >= runningPerSession)
      throw new TargetRefusal(
        "invalid",
        `At most ${runningPerSession} background commands run at once; stop one with command_stop.`,
      );
    for (const old of mine.filter((job) => job.outcome).slice(0, -keptPerSession + 1))
      this.jobs.delete(old.id);
    const id = `job-${this.deps.newId()}`.toLowerCase();
    const controller = new AbortController();
    const made: { job?: Job } = {};
    const label = `${clip(command, 120)} from ${this.caller(session)}`;
    // The row opens first, so the job shows and keeps the session from reading done while it
    // runs; the person's Stop, a lowered grant or command_stop ends its whole process tree.
    const held = this.deps.guests.run(
      session,
      { capability: "commands", risk: "operate", label },
      controller.signal,
      (stop) => {
        const run = runCommand(this.deps.spawn, this.deps.clock, spec, limits);
        made.job = { id, session, command, cwd: spec.cwd, run, controller };
        stop.addEventListener("abort", () => run.stop(), { once: true });
        return run.done;
      },
    );
    held.catch(() => undefined);
    const started = made.job;
    if (!started) {
      await held;
      throw new TargetRefusal("unavailable", "The command did not start.");
    }
    this.jobs.set(id, started);
    const key = `ace-command:${id}`;
    this.record(session, key, command, spec.cwd, started.run.startedAt);
    void started.run.done.then((outcome) => {
      started.outcome = outcome;
      this.finished(session, key, command, spec.cwd, started.run, outcome);
    });
    return {
      content: [
        text(
          `Started ${id} in ${spec.cwd}. Read it with command_status and command_output; end it with command_stop.`,
        ),
      ],
    };
  }
  private job(session: GuestSession, raw: Record<string, unknown>): Job {
    const parsed = CommandJobArgs.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error);
    return this.owned(session, parsed.data.jobId);
  }
  /** One of this calling thread's jobs; another thread's ids name nothing. */
  private owned(session: GuestSession, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.session.threadId !== session.threadId)
      throw new TargetRefusal("invalid", "No such command job from this thread.");
    return job;
  }
  private status(job: Job): MachineToolResult {
    const { run, outcome } = job;
    const seconds = ((this.deps.clock.now() - run.startedAt) / 1000).toFixed(1);
    const state = outcome ? outcomeLine(outcome) : `Running for ${seconds} s.`;
    return {
      content: [
        text(
          `${job.id}: ${state}\ncommand: ${job.command}\ncwd: ${job.cwd}\nstdout: ${run.stdout.total} bytes, stderr: ${run.stderr.total} bytes`,
        ),
      ],
    };
  }
  private output(session: GuestSession, raw: Record<string, unknown>): MachineToolResult {
    const parsed = CommandOutputArgs.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error);
    const { jobId, stream, offset, maxBytes } = parsed.data;
    const job = this.owned(session, jobId);
    const tail = job.run[stream];
    const page = tail.read(offset, maxBytes);
    const end = page.offset + page.bytes.length;
    const notes = [
      `${stream} bytes ${page.offset}–${end} of ${tail.total}${job.outcome ? "" : " so far"}.`,
      ...(offset !== undefined && offset < tail.start
        ? [`Bytes before ${tail.start} are no longer kept.`]
        : []),
      ...(end < tail.total ? [`More: offset ${end}.`] : []),
    ];
    return { content: [text(notes.join(" ")), text(page.bytes.toString("utf8"))] };
  }
  private async stop(job: Job): Promise<MachineToolResult> {
    job.controller.abort(new Error("stopped"));
    job.run.stop();
    const outcome = await job.run.done;
    return { content: [text(`${job.id}: ${outcomeLine(outcome)}`)] };
  }
  private result(outcome: CommandOutcome, cwd: string, run: RunningCommand): MachineToolResult {
    const content = [text(`${outcomeLine(outcome)}\ncwd: ${cwd}`)];
    if (run.stdout.total > 0) content.push(text(`stdout:\n${run.stdout.text()}`));
    if (run.stderr.total > 0) content.push(text(`stderr:\n${run.stderr.text()}`));
    return { ...(outcome.exitCode === 0 ? {} : { isError: true }), content };
  }
  /** The calling machine and thread, from the session's record. */
  private origin(session: GuestSession) {
    const row = this.deps.store
      .statement("SELECT origin_host,origin_thread FROM machine_threads WHERE thread_id=?")
      .get(session.threadId);
    const parsed = Origin.safeParse(row);
    return parsed.success ? parsed.data : { origin_host: "", origin_thread: "" };
  }
  private caller(session: GuestSession): string {
    return this.deps.store.getThread(session.threadId)?.details?.guest?.name ?? "another machine";
  }
  private record(session: GuestSession, key: string, command: string, cwd: string, at: number) {
    this.deps.engine()?.guests.command(session.threadId, key, {
      command,
      cwd,
      status: "running",
      startedAt: at,
    });
  }
  /** Every command is logged on this machine and kept in the session's transcript. */
  private finished(
    session: GuestSession,
    key: string,
    command: string,
    cwd: string,
    run: RunningCommand,
    outcome: CommandOutcome,
  ) {
    const origin = this.origin(session);
    this.deps.log("Command from another machine", {
      deviceId: session.deviceId,
      fromMachine: origin.origin_host,
      fromThread: origin.origin_thread,
      session: session.threadId,
      cwd,
      command: clip(command, 1000),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      outcome: outcome.timedOut ? "timed_out" : outcome.stopped ? "stopped" : "exited",
    });
    try {
      this.deps.engine()?.guests.command(session.threadId, key, {
        command,
        cwd,
        status:
          outcome.stopped || outcome.timedOut
            ? "cancelled"
            : outcome.exitCode === 0
              ? "succeeded"
              : "failed",
        exitCode: outcome.exitCode,
        startedAt: run.startedAt,
        endedAt: run.startedAt + outcome.durationMs,
      });
    } catch {
      // The person deleted the session meanwhile; the log above still has it.
    }
  }
}
