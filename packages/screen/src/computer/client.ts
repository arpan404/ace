/*
 * The daemon's side of `ace-screen-helper --computer`: JSON lines over stdin/stdout, to a pool
 * of helpers. Each app gets its own helper, so agents in different apps run in parallel and a
 * hung app only ever stalls its own; one shared helper answers `hello`, `apps` and `resolve`.
 * Helpers start on first use, restart after they exit or stop answering, and exit after a
 * while idle. At most `maxHelpers` app helpers live; the least recently used idle one goes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { systemScheduler, type Scheduler } from "../runtime.ts";
import { ComputerError } from "./errors.ts";
import { HelperConnection } from "./helper-connection.ts";
import { performance } from "node:perf_hooks";
import type { ComputerRequestTiming } from "./timing.ts";

export { ComputerError } from "./errors.ts";
export type { ComputerRequestTiming } from "./timing.ts";

export interface ComputerClientOptions {
  /** The installed helper executable; resolved before every start. */
  helper: () => Promise<string>;
  nextId: () => string;
  /**
   * The helper's environment, read before every start; defaults to the daemon's own. On Linux
   * it carries the graphical session; throwing a `ComputerError` refuses the start with that
   * message for the model.
   */
  environment?: () => Promise<NodeJS.ProcessEnv>;
  /** Arguments after `--computer`, such as Linux's `--data-dir` for screen-sharing approvals. */
  helperArgs?: readonly string[];
  /** Starts a helper. Tests substitute a fake process. */
  spawnHelper?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
  /** How long each op may run, from when it is sent, before it is cancelled. */
  deadlineMs?: (op: string) => number;
  /** How long a cancelled or overdue request may take to reply before its helper is killed. */
  graceMs?: number;
  /**
   * Windows: how long a helper may take to exit after its stdin closes before it is killed.
   * A kill there is immediate, so the helper gets this long to put back a borrowed clipboard
   * and release held keys. Unset elsewhere, where SIGTERM lets it do that.
   */
  stopGraceMs?: number;
  /** How long an app's helper may sit idle before it exits. */
  idleMs?: number;
  /** App helpers kept alive at once. */
  maxHelpers?: number;
  /** Largest reply line accepted; a longer one fails its request at once. */
  maxReplyBytes?: number;
  scheduler?: Scheduler;
  /** Optional diagnostics. Contains durations, never arguments, titles or screenshots. */
  timing?: { now?: () => number; report: (timing: ComputerRequestTiming) => void };
}

export interface ComputerRequestOptions {
  signal?: AbortSignal | undefined;
  /** The app the request acts on; defaults to the payload's `app` for state and act. */
  app?: string | undefined;
}

/** Ops about the computer as a whole rather than one app. */
const catalogOps: ReadonlySet<string> = new Set(["hello", "apps", "resolve"]);
const catalog = "\u0000catalog";

/** Launching, settling and capturing take seconds; a batch of actions takes longest. */
export function defaultDeadlineMs(op: string): number {
  return op === "act" ? 85_000 : op === "state" ? 40_000 : 15_000;
}

interface Entry {
  connection: HelperConnection;
  idle: boolean;
  /** Use order, for least-recently-used eviction. */
  used: number;
  stopIdle: () => void;
}

export class ComputerClient {
  private readonly options: ComputerClientOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly scheduler: Scheduler;
  private uses = 0;
  private closed = false;

  constructor(options: ComputerClientOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  async request(
    op: string,
    payload: Record<string, unknown>,
    { signal, app }: ComputerRequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) throw new ComputerError("closed", "Computer use is shutting down.");
    signal?.throwIfAborted();
    const target = typeof payload["app"] === "string" ? payload["app"] : undefined;
    const key = catalogOps.has(op) ? catalog : (app ?? target ?? catalog).toLowerCase();
    const entry = this.entry(key);
    entry.used = ++this.uses;
    return entry.connection.request(
      op,
      payload,
      (this.options.deadlineMs ?? defaultDeadlineMs)(op),
      signal,
    );
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.stopIdle();
      entry.connection.close();
    }
    this.entries.clear();
  }

  private entry(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: Entry = {
      connection: new HelperConnection({
        start: async () => {
          const env = (await this.options.environment?.()) ?? process.env;
          const command = await this.options.helper();
          return (this.options.spawnHelper ?? defaultSpawn)(
            command,
            ["--computer", ...(this.options.helperArgs ?? [])],
            env,
          );
        },
        nextId: this.options.nextId,
        scheduler: this.scheduler,
        maxReplyBytes: this.options.maxReplyBytes ?? 32 * 1024 * 1024,
        graceMs: this.options.graceMs ?? 3_000,
        ...(this.options.stopGraceMs !== undefined
          ? { stopGraceMs: this.options.stopGraceMs }
          : {}),
        idle: (idle) => this.idleChanged(key, entry, idle),
        ...(this.options.timing
          ? {
              timing: {
                now: this.options.timing.now ?? (() => performance.now()),
                report: (timing: ComputerRequestTiming) =>
                  this.options.timing?.report({
                    ...timing,
                    ...(key === catalog ? {} : { app: key }),
                  }),
              },
            }
          : {}),
      }),
      // About to take a request: never the one trimmed to make room for itself.
      idle: false,
      used: ++this.uses,
      stopIdle: () => {},
    };
    this.entries.set(key, entry);
    this.trim();
    return entry;
  }

  private idleChanged(key: string, entry: Entry, idle: boolean): void {
    entry.idle = idle;
    entry.stopIdle();
    entry.stopIdle = () => {};
    if (!idle || this.entries.get(key) !== entry) return;
    entry.stopIdle = this.scheduler.after(this.options.idleMs ?? 5 * 60_000, () => {
      if (entry.idle && this.entries.get(key) === entry) this.drop(key, entry);
    });
    this.trim();
  }

  /** Over the limit, the least recently used idle app helpers exit. */
  private trim(): void {
    const max = this.options.maxHelpers ?? 6;
    const apps = [...this.entries].filter(([key]) => key !== catalog);
    let excess = apps.length - max;
    if (excess <= 0) return;
    for (const [key, entry] of apps.toSorted(([, a], [, b]) => a.used - b.used)) {
      if (excess <= 0) break;
      if (!entry.idle || entry.connection.busy()) continue;
      this.drop(key, entry);
      excess--;
    }
  }

  private drop(key: string, entry: Entry): void {
    entry.stopIdle();
    this.entries.delete(key);
    entry.connection.close();
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
}
