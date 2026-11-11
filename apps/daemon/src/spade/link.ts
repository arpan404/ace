import { join } from "node:path";
import type { SpadeStatus } from "@ace/protocol";
import type { SpadeConnection } from "./forward.ts";
import {
  readServerFile,
  readTokenFile,
  spadeState,
  type SpadeEndpoint,
  type SpadeFacts,
  type SpadeServiceState,
} from "./rules.ts";

/** Everything the link reads of the outside world, so tests can substitute any of it. */
export interface SpadeLinkRuntime {
  readText(path: string): Promise<string | undefined>;
  healthy(endpoint: SpadeEndpoint, signal: AbortSignal): Promise<boolean>;
  /** Spade's registration with the service manager (`spadeServiceState` from `@ace/service`). */
  serviceState(): Promise<SpadeServiceState>;
  /** Calls `changed` when files in `directory` change; returns a stop. */
  watch(directory: string, changed: () => void): () => void;
  now(): number;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
}
export interface SpadeLinkOptions {
  /** `<ACE_HOME>/spade`: `server.json` and `token` live here. */
  dataDir: string;
  runtime: SpadeLinkRuntime;
  /** How often to look again while Spade isn't ready, and while it is. */
  pollMs?: { waiting: number; ready: number };
  healthTimeoutMs?: number;
}
export interface SpadeReady {
  connection: SpadeConnection;
  /** Counts Spade instances seen ready; a stream opened to one ends when that one goes. */
  generation: number;
}

const defaultPoll = { waiting: 1000, ready: 5000 };

/**
 * The daemon's view of the Spade service (ADR 0123). The daemon doesn't run Spade: it reads the
 * service's registration, `server.json`, the token file and `GET /health`, looks again when the
 * files change and on a timer, and reports `spade.status` from what it sees. Each Spade instance
 * that answers gets a generation, so forwarded streams end when it goes.
 */
export class SpadeLink {
  private facts: SpadeFacts = { enabled: false, service: "absent", healthy: false, silentForMs: 0 };
  private current: SpadeStatus = { state: "off" };
  private thread: SpadeStatus["thread"];
  private live: (SpadeReady & { key: string }) | undefined;
  private generation = 0;
  private silentSince: number | undefined;
  private readonly listeners = new Set<(status: SpadeStatus) => void>();
  private readonly endings = new Set<(generation: number) => void>();
  private readonly arrivals = new Set<(ready: SpadeReady) => void>();
  private readonly options: SpadeLinkOptions;
  private running: Promise<void> | undefined;
  private again = false;
  private cancelTimer: (() => void) | undefined;
  private stopWatch: (() => void) | undefined;
  private closed = false;
  constructor(options: SpadeLinkOptions) {
    this.options = options;
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
  /** Called with the generation of each ready instance as it goes. */
  onRunEnded(listener: (generation: number) => void): () => void {
    this.endings.add(listener);
    return () => this.endings.delete(listener);
  }
  /** Called each time a new Spade instance is seen ready. */
  onReady(listener: (ready: SpadeReady) => void): () => void {
    this.arrivals.add(listener);
    return () => this.arrivals.delete(listener);
  }
  ready(): SpadeReady | undefined {
    return this.live && { connection: this.live.connection, generation: this.live.generation };
  }
  /** Follows `spade.enabled`: watching and polling run only while it is on. */
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.facts.enabled) return;
    this.facts = { ...this.facts, enabled };
    this.silentSince = undefined;
    if (enabled) {
      this.stopWatch = this.options.runtime.watch(this.options.dataDir, () => this.refresh());
    } else {
      this.stopWatch?.();
      this.stopWatch = undefined;
      this.cancelTimer?.();
      this.cancelTimer = undefined;
    }
    this.refresh();
  }
  /** Turning on is underway (`installing`), or failed with `problem`; cleared with undefined. */
  setSwitch(input: { installing?: boolean; problem?: string | undefined }): void {
    this.facts = { ...this.facts, installing: input.installing ?? false, problem: input.problem };
    this.refresh();
  }
  /** Looks again now; overlapping calls fold into one more look. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.look().finally(() => {
      this.running = undefined;
      if (this.again && !this.closed) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stopWatch?.();
    this.cancelTimer?.();
    await this.running;
    this.leave();
    this.listeners.clear();
    this.endings.clear();
    this.arrivals.clear();
  }

  private async look(): Promise<void> {
    const { runtime, dataDir } = this.options;
    if (!this.facts.enabled) return this.apply(this.facts, undefined);
    const service = await runtime.serviceState().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const text = await runtime.readText(join(dataDir, "server.json"));
    const endpoint = text === undefined ? undefined : readServerFile(text);
    const tokenText = endpoint && (await runtime.readText(join(dataDir, "token")));
    const token = tokenText ? readTokenFile(tokenText) : undefined;
    const healthy =
      endpoint !== undefined &&
      token !== undefined &&
      (await runtime
        .healthy(endpoint, AbortSignal.timeout(this.options.healthTimeoutMs ?? 2000))
        .catch(() => false));
    const now = runtime.now();
    if (healthy || service !== "running") this.silentSince = undefined;
    else this.silentSince ??= now;
    if (this.closed || !this.facts.enabled) return;
    const facts: SpadeFacts = {
      ...this.facts,
      service,
      endpoint: endpoint && token ? endpoint : undefined,
      healthy,
      silentForMs: this.silentSince === undefined ? 0 : now - this.silentSince,
    };
    this.apply(facts, healthy && endpoint && token ? { endpoint, token } : undefined);
    const poll = this.options.pollMs ?? defaultPoll;
    this.cancelTimer?.();
    this.cancelTimer = runtime.after(healthy ? poll.ready : poll.waiting, () => {
      void this.refresh();
    });
  }
  private apply(
    facts: SpadeFacts,
    answering: { endpoint: SpadeEndpoint; token: string } | undefined,
  ): void {
    this.facts = facts;
    const key = answering
      ? `${answering.endpoint.pid}@${answering.endpoint.port}:${answering.token}`
      : undefined;
    if (this.live && this.live.key !== key) this.leave();
    let arrived: SpadeReady | undefined;
    if (answering && key && !this.live) {
      const { endpoint, token } = answering;
      this.live = {
        key,
        connection: { host: endpoint.host, port: endpoint.port, token },
        generation: ++this.generation,
      };
      arrived = this.ready();
    }
    const before = JSON.stringify(this.status());
    this.current = spadeState(facts);
    this.announce(before);
    if (arrived) for (const listener of this.arrivals) listener(arrived);
  }
  private leave(): void {
    const left = this.live;
    this.live = undefined;
    if (left) for (const listener of this.endings) listener(left.generation);
  }
  private announce(before: string): void {
    const status = this.status();
    if (JSON.stringify(status) === before) return;
    for (const listener of this.listeners) listener(status);
  }
}
