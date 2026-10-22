/*
 * One `ace-screen-helper --computer` process and its queue. Requests run one at a time, as the
 * helper runs them; `cancel` goes straight to the helper. A cancelled or overdue request is
 * given a grace period to reply (an act replies with the steps it finished); a helper that
 * does not reply in time is killed, and the next request starts a fresh one.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Scheduler } from "../runtime.ts";
import { ComputerError } from "./errors.ts";
import { ReplyLines } from "./reply-lines.ts";
import { ComputerReply } from "./wire.ts";

export interface HelperConnectionOptions {
  /** Starts a helper process. */
  start: () => Promise<ChildProcessWithoutNullStreams>;
  nextId: () => string;
  scheduler: Scheduler;
  maxReplyBytes: number;
  /** How long a cancelled or overdue request may take to reply before its helper is killed. */
  graceMs: number;
  /** Called when nothing is queued or running any more, and when work arrives again. */
  idle: (idle: boolean) => void;
}

interface Job {
  id: string;
  op: string;
  line: string;
  deadlineMs: number;
  signal: AbortSignal | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The helper the request was written to; only its exit or kill fails the request. */
  child?: ChildProcessWithoutNullStreams;
  /** Set once the request is being stopped: why, for the error it ends with. */
  ending?: "cancelled" | "timeout";
  stops: (() => void)[];
}

const timeoutMessage =
  "The app did not respond in time (it may be busy or stuck on a dialog). Try again; if it keeps failing, take a screenshot to see what it is showing.";
const exitedMessage = "The computer-use helper stopped. Try again.";

function endingError(job: Job, result?: unknown): ComputerError {
  return job.ending === "timeout"
    ? new ComputerError("timeout", timeoutMessage, result)
    : new ComputerError("cancelled", "Cancelled.", result);
}

export class HelperConnection {
  private readonly options: HelperConnectionOptions;
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private closed = false;

  constructor(options: HelperConnectionOptions) {
    this.options = options;
  }

  /** Running or waiting requests. */
  busy(): boolean {
    return this.current !== undefined || this.queue.length > 0;
  }

  request(
    op: string,
    payload: Record<string, unknown>,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new ComputerError("closed", "Computer use stopped."));
    const wasBusy = this.busy();
    const id = this.options.nextId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const job: Job = {
        id,
        op,
        line: `${JSON.stringify({ ...payload, op, id })}\n`,
        deadlineMs,
        signal,
        resolve,
        reject,
        stops: [],
      };
      if (signal) {
        const onAbort = () => this.cancel(job, "cancelled");
        signal.addEventListener("abort", onAbort, { once: true });
        job.stops.push(() => signal.removeEventListener("abort", onAbort));
      }
      this.queue.push(job);
    });
    if (!wasBusy) this.options.idle(false);
    this.pump();
    return promise;
  }

  /** Kills the helper and fails everything queued or running. */
  close(): void {
    this.closed = true;
    const error = new ComputerError("closed", "Computer use stopped.");
    for (const job of this.queue.splice(0)) this.settle(job, () => job.reject(error));
    const job = this.current;
    if (job) this.finish(job, () => job.reject(error));
    this.kill();
  }

  private pump(): void {
    if (this.current || this.closed) return;
    const job = this.queue.shift();
    if (!job) {
      this.options.idle(true);
      return;
    }
    this.current = job;
    void this.write(job);
  }

  private async write(job: Job): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await this.process();
    } catch (error) {
      // A refusal already written for the model (no graphical session) reaches it as it is.
      if (error instanceof ComputerError) return this.finish(job, () => job.reject(error));
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(job, () =>
        job.reject(
          new ComputerError(
            "helper_unavailable",
            `The computer-use helper could not start: ${message}`,
          ),
        ),
      );
    }
    // Cancelled while the helper started.
    if (this.current !== job || job.ending) return;
    job.child = child;
    job.stops.push(this.options.scheduler.after(job.deadlineMs, () => this.cancel(job, "timeout")));
    child.stdin.write(job.line, (error) => {
      if (error && job.child === child && this.current === job) this.kill();
    });
  }

  /** Stops a request: unsent ones end now; sent ones get a cancel and a grace period. */
  private cancel(job: Job, why: "cancelled" | "timeout"): void {
    if (job.ending) return;
    job.ending = why;
    const queued = this.queue.indexOf(job);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.settle(job, () => job.reject(endingError(job)));
      return;
    }
    if (this.current !== job) return;
    const child = job.child;
    if (!child) return this.finish(job, () => job.reject(endingError(job)));
    const cancelLine = `${JSON.stringify({ id: this.options.nextId(), op: "cancel", target: job.id })}\n`;
    child.stdin.write(cancelLine, () => {});
    job.stops.push(
      this.options.scheduler.after(this.options.graceMs, () => {
        if (this.current !== job) return;
        // It ignored the cancel: the helper (and only this app's helper) is stuck.
        if (this.child === child) this.kill();
        this.finish(job, () => job.reject(endingError(job)));
      }),
    );
  }

  private process(): Promise<ChildProcessWithoutNullStreams> {
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) return Promise.resolve(child);
    this.starting ??= this.options
      .start()
      .then((started) => {
        this.attach(started);
        this.child = started;
        // Closed while it started: it never gets work.
        if (this.closed) this.kill();
        return started;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    const lines = new ReplyLines(this.options.maxReplyBytes);
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of lines.push(chunk)) {
        if (line.kind === "oversize") this.oversize(child, line.id);
        else this.reply(child, line.text);
      }
    });
    child.stderr.resume();
    const failed = (code: string, message: string) => () => {
      if (this.child === child) this.child = undefined;
      const job = this.current;
      if (job?.child === child)
        this.finish(job, () =>
          job.reject(job.ending ? endingError(job) : new ComputerError(code, message)),
        );
    };
    child.on("error", failed("helper_unavailable", "The computer-use helper could not start."));
    child.on("exit", failed("helper_exited", exitedMessage));
  }

  private reply(child: ChildProcessWithoutNullStreams, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const reply = ComputerReply.safeParse(parsed);
    const job = this.current;
    if (!reply.success || !job || job.child !== child || reply.data.id !== job.id) return;
    const data = reply.data;
    this.finish(job, () => {
      if (job.ending) job.reject(endingError(job, data.ok ? data.result : undefined));
      else if (data.ok) job.resolve(data.result);
      else job.reject(new ComputerError(data.error.code, data.error.message));
    });
  }

  private oversize(child: ChildProcessWithoutNullStreams, id: string | undefined): void {
    const job = this.current;
    // One request runs at a time, so a reply without a readable id is the running one's.
    if (!job || job.child !== child || (id !== undefined && id !== job.id)) return;
    const mb = Math.round(this.options.maxReplyBytes / (1024 * 1024));
    this.finish(job, () =>
      job.reject(
        new ComputerError(
          "reply_too_large",
          `The app's reply was larger than ${mb} MB. Ask for less: use find, skip the screenshot, or pick a smaller window.`,
        ),
      ),
    );
  }

  /** Ends the running request and starts the next. */
  private finish(job: Job, end: () => void): void {
    if (this.current === job) this.current = undefined;
    this.settle(job, end);
    this.pump();
  }

  private settle(job: Job, end: () => void): void {
    for (const stop of job.stops.splice(0)) stop();
    end();
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    // SIGTERM lets the helper put back the clipboard it borrowed for a paste.
    child.kill("SIGTERM");
  }
}
