import { join } from "node:path";
import type { SpadeStatus } from "@ace/protocol";
import type { SpadeConnection } from "./forward.ts";
import {
  defaultBackoff,
  exitReason,
  failuresAfterExit,
  readServerFile,
  readTokenFile,
  restartDelay,
  type Backoff,
  type SpadeEndpoint,
} from "./rules.ts";

export interface SpadeExit {
  code: number | null;
  signal: string | null;
  /** The process supervisor stopped it on request (the daemon's own stop), not a crash. */
  requested?: boolean;
}
type RunOutcome = { readyForMs: number | undefined; reason: string; stopped?: true };
export interface SpadeChild {
  readonly pid: number | undefined;
  readonly exited: Promise<SpadeExit>;
  /** SIGTERM, then kill once `graceMs` passes; resolves when the process is gone. */
  stop(graceMs: number): Promise<unknown>;
}
/** Everything the host does to the outside world, so tests can substitute any of it. */
export interface SpadeHostRuntime {
  spawn(input: { command: string; env: Record<string, string> }): SpadeChild;
  readText(path: string): Promise<string | undefined>;
  ensureDirectory(path: string): void;
  healthy(endpoint: SpadeEndpoint, signal: AbortSignal): Promise<boolean>;
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
/** Credentials issued for one Spade run and revoked when that run ends. */
export interface SpadeCredentials {
  env: Record<string, string>;
  revoke(): void;
}
export interface SpadeHostOptions {
  /** `<ACE_HOME>/spade`. */
  dataDir: string;
  binary(): string | undefined;
  credentials(): Promise<SpadeCredentials>;
  runtime: SpadeHostRuntime;
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
  backoff?: Backoff;
  readyTimeoutMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
}
export interface SpadeReady {
  connection: SpadeConnection;
  /** Counts ready runs; a stream opened in one run ends when that run ends. */
  generation: number;
}

const stoppedOutcome: RunOutcome = {
  readyForMs: undefined,
  reason: "Spade was stopped.",
  stopped: true,
};
const notInstalled = "Spade isn't installed: no spade-server binary was found.";

/**
 * Runs Spade while it is enabled (ADR 0117): start, wait for its `server.json` and `/health`,
 * restart a crash with backoff, and stop it with SIGTERM then a kill.
 */
export class SpadeHost {
  private current: SpadeStatus = { state: "off" };
  private thread: SpadeStatus["thread"];
  private readonly listeners = new Set<(status: SpadeStatus) => void>();
  private readonly endings = new Set<(generation: number) => void>();
  private live: SpadeReady | undefined;
  private generation = 0;
  private enabled = false;
  private closed = false;
  private controller: AbortController | undefined;
  private loop: Promise<void> = Promise.resolve();
  private readonly options: SpadeHostOptions;
  private readonly backoff: Backoff;
  constructor(options: SpadeHostOptions) {
    this.options = options;
    this.backoff = options.backoff ?? defaultBackoff;
  }
  status(): SpadeStatus {
    return this.thread ? { ...this.current, thread: this.thread } : this.current;
  }
  /** Spade's host thread and whether its tree is busy, reported with every status. */
  setThread(thread: SpadeStatus["thread"]): void {
    const before = JSON.stringify(this.status());
    this.thread = thread;
    this.announce(before);
  }
  subscribe(listener: (status: SpadeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Called with the generation of each ready run as it ends. */
  onRunEnded(listener: (generation: number) => void): () => void {
    this.endings.add(listener);
    return () => this.endings.delete(listener);
  }
  ready(): SpadeReady | undefined {
    return this.live;
  }
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      const controller = new AbortController();
      this.controller = controller;
      this.loop = this.loop.then(() => this.run(controller.signal));
    } else {
      this.controller?.abort();
      this.loop = this.loop.then(() => {
        if (!this.enabled) this.set({ state: "off" });
      });
    }
  }
  async close(): Promise<void> {
    this.setEnabled(false);
    this.closed = true;
    await this.loop;
    this.listeners.clear();
    this.endings.clear();
  }

  private set(status: SpadeStatus): void {
    const before = JSON.stringify(this.status());
    this.current = status;
    this.announce(before);
  }
  private announce(before: string): void {
    const status = this.status();
    if (JSON.stringify(status) === before) return;
    for (const listener of this.listeners) listener(status);
  }
  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const binary = this.options.binary();
      if (!binary) {
        this.set({ state: "off", reason: notInstalled });
        return;
      }
      this.set({ state: "starting" });
      const outcome = await this.once(binary, signal).catch((error: unknown): RunOutcome => ({
        readyForMs: undefined,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (signal.aborted) return;
      if (outcome.stopped) {
        // Stopped on the daemon's request (its shutdown): not a failure, and not restarted.
        // The next time Spade is turned on starts it again.
        this.options.log("info", "Spade stopped", { reason: outcome.reason });
        this.enabled = false;
        this.set({ state: "off", reason: outcome.reason });
        return;
      }
      failures = failuresAfterExit(failures, outcome.readyForMs, this.backoff);
      const delay = restartDelay(failures, this.backoff);
      this.options.log("warn", "Spade failed", {
        reason: outcome.reason,
        failures,
        restartInMs: delay,
      });
      this.set({ state: "failed", reason: outcome.reason });
      await this.options.runtime.sleep(delay, signal);
    }
  }
  /** One run of Spade, from spawn until it exits or is stopped. */
  private async once(binary: string, signal: AbortSignal): Promise<RunOutcome> {
    const { runtime } = this.options;
    runtime.ensureDirectory(this.options.dataDir);
    const credentials = await this.options.credentials();
    let child: SpadeChild;
    try {
      child = runtime.spawn({
        command: binary,
        env: {
          ...credentials.env,
          SPADE_DATA_DIR: this.options.dataDir,
          SPADE_LISTEN: "127.0.0.1:0",
          RUST_LOG: "info",
        },
      });
    } catch (error) {
      credentials.revoke();
      throw error;
    }
    const grace = this.options.stopGraceMs ?? 5000;
    let generation: number | undefined;
    // Streams of a run end as soon as it is over or being stopped, before its sockets close.
    const ended = () => {
      if (generation === undefined || this.live?.generation !== generation) return;
      this.live = undefined;
      for (const listener of this.endings) listener(generation);
    };
    const stop = () => {
      ended();
      void child.stop(grace).catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    // Readiness waits end when the child exits or the host stops.
    const waiting = new AbortController();
    const abortWait = () => waiting.abort();
    signal.addEventListener("abort", abortWait, { once: true });
    // Stopped while credentials were being issued: the listeners above came too late.
    if (signal.aborted) {
      stop();
      abortWait();
    }
    const exited = child.exited.then((value) => {
      waiting.abort();
      return value;
    });
    try {
      const pid = child.pid;
      const ready = pid === undefined ? undefined : await this.waitReady(pid, waiting.signal);
      if (!ready) {
        // Neither exited nor stopped: the readiness deadline passed.
        const timedOut = pid !== undefined && !waiting.signal.aborted;
        if (timedOut) stop();
        const exit = await exited;
        if (!timedOut && exit.requested) return stoppedOutcome;
        const seconds = Math.round((this.options.readyTimeoutMs ?? 15_000) / 1000);
        return {
          readyForMs: undefined,
          reason: timedOut ? `Spade didn't become ready within ${seconds} s.` : exitReason(exit),
        };
      }
      const readyAt = runtime.now();
      generation = ++this.generation;
      this.live = { connection: ready.connection, generation };
      this.options.log("info", "Spade ready", {
        port: ready.connection.port,
        version: ready.version,
      });
      this.set({ state: "ready", version: ready.version });
      const exit = await exited;
      if (exit.requested) return stoppedOutcome;
      return { readyForMs: runtime.now() - readyAt, reason: exitReason(exit) };
    } finally {
      signal.removeEventListener("abort", stop);
      signal.removeEventListener("abort", abortWait);
      ended();
      credentials.revoke();
    }
  }
  /**
   * Polls for `server.json`, the token and `/health` until the deadline, the child's exit or a
   * stop. The deadline aborts the probe in flight too, so a `/health` that never answers can't
   * hold Spade in `starting`.
   */
  private async waitReady(
    pid: number,
    signal: AbortSignal,
  ): Promise<{ connection: SpadeConnection; version: string } | undefined> {
    const { runtime } = this.options;
    const expired = new AbortController();
    const settled = new AbortController();
    const probe = AbortSignal.any([signal, expired.signal]);
    void runtime
      .sleep(this.options.readyTimeoutMs ?? 15_000, AbortSignal.any([probe, settled.signal]))
      .then(() => expired.abort());
    try {
      return await this.poll(pid, probe);
    } finally {
      settled.abort();
    }
  }
  private async poll(
    pid: number,
    probe: AbortSignal,
  ): Promise<{ connection: SpadeConnection; version: string } | undefined> {
    const { runtime, dataDir } = this.options;
    const until = <T>(work: Promise<T>): Promise<T | undefined> =>
      Promise.race([work, aborted(probe)]);
    while (!probe.aborted) {
      const text = await until(runtime.readText(join(dataDir, "server.json")));
      const endpoint = text === undefined ? undefined : readServerFile(text, pid);
      if (endpoint) {
        const tokenText = await until(runtime.readText(join(dataDir, "token")));
        const token = tokenText === undefined ? undefined : readTokenFile(tokenText);
        if (token && (await until(runtime.healthy(endpoint, probe))) === true && !probe.aborted)
          return {
            connection: { host: endpoint.host, port: endpoint.port, token },
            version: endpoint.version,
          };
      }
      await runtime.sleep(this.options.pollMs ?? 100, probe);
    }
    return undefined;
  }
}

/** Resolves with undefined once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}
