import { join } from "node:path";
import type { SpadeStatus } from "@ace/protocol";
import { checkSpadeProof, type SpadeHealth } from "@ace/service/spade";
import type { SpadeConnection } from "./forward.ts";
import {
  spadeStartGraceMs,
  readSpadeServerFile,
  readTokenFile,
  spadeAnswering,
  spadeState,
  type SpadeEndpoint,
  type SpadeFacts,
  type SpadeServiceState,
} from "./rules.ts";

/** Everything the link reads of the outside world, so tests can substitute any of it. */
export interface SpadeLinkRuntime {
  readText(path: string): Promise<string | undefined>;
  /** `GET /health?nonce=…` (`spadeHealth`): undefined when nothing answered `ok`. */
  health(
    endpoint: SpadeEndpoint,
    nonce: string,
    signal: AbortSignal,
  ): Promise<SpadeHealth | undefined>;
  /** Whether a process with this pid is running. */
  alive(pid: number): boolean;
  /** A fresh nonce for `/health`: 16 to 64 lowercase hex characters. */
  nonce(): string;
  /** Spade's registration with the service manager (`spadeServiceState` from `@ace/service`). */
  serviceState(): Promise<SpadeServiceState>;
  /** Calls `changed` when files in `directory` change; returns a stop. */
  watch(directory: string, changed: () => void): () => void;
  now(): number;
  /** This machine's platform (`process.platform`), for how Spade's setup waits are worded. */
  platform?: string;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
}
export interface SpadeLinkOptions {
  /** `<ACE_HOME>/spade`: `server.json` and `token` live here. */
  dataDir: string;
  runtime: SpadeLinkRuntime;
  /**
   * How often to look again while Spade isn't ready, and while it is. While it stays silent past
   * its start grace, the wait doubles from `waiting` up to `idle`.
   */
  pollMs?: { waiting: number; ready: number; idle?: number };
  healthTimeoutMs?: number;
}
export interface SpadeReady {
  connection: SpadeConnection;
  /** Counts Spade instances seen ready; a stream opened to one ends when that one goes. */
  generation: number;
}

const defaultPoll = { waiting: 1000, ready: 5000, idle: 60_000 };

/**
 * The daemon's view of the Spade service (ADR 0123). The daemon doesn't run Spade: it reads the
 * service's registration, `server.json`, the token file and `GET /health`, looks again when the
 * files change and on a timer, and reports `spade.status` from what it sees. Each Spade instance
 * that answers gets a generation, so forwarded streams end when it goes.
 */
const hiddenStatus: SpadeStatus = {
  state: "off",
  hidden: true,
  reason: "Spade is hidden on this machine.",
};

export class SpadeLink {
  private facts: SpadeFacts = { enabled: false, service: "absent", healthy: false, silentForMs: 0 };
  private current: SpadeStatus = { state: "off" };
  private thread: SpadeStatus["thread"];
  private grant: SpadeStatus["grant"];
  private revoker: (() => Promise<boolean>) | undefined;
  private hidden = false;
  private live: (SpadeReady & { key: string }) | undefined;
  private generation = 0;
  private silentSince: number | undefined;
  /** Looks in a row that found Spade not answering past its start grace: the backoff. */
  private misses = 0;
  private readonly listeners = new Set<(status: SpadeStatus) => void>();
  private readonly endings = new Set<(generation: number) => void>();
  private readonly arrivals = new Set<(ready: SpadeReady) => void>();
  private readonly options: SpadeLinkOptions;
  private running: Promise<void> | undefined;
  private next: Promise<void> | undefined;
  private cancelTimer: (() => void) | undefined;
  private stopWatch: (() => void) | undefined;
  private closed = false;
  constructor(options: SpadeLinkOptions) {
    this.options = options;
  }
  status(): SpadeStatus {
    if (this.hidden) return hiddenStatus;
    return {
      ...this.current,
      ...(this.thread ? { thread: this.thread } : {}),
      ...(this.grant ? { grant: this.grant } : {}),
    };
  }
  /**
   * Spade hidden on this machine (`features.json`, ADR 0139): the status says only that, and
   * nothing is forwarded, whatever Spade's own state.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    const before = JSON.stringify(this.status());
    this.hidden = hidden;
    this.announce(before);
  }
  /** Spade's grant for ace, reported with every status (never its token). */
  setGrant(grant: SpadeStatus["grant"]): void {
    const before = JSON.stringify(this.status());
    this.grant = grant;
    this.announce(before);
  }
  /** Who revokes Spade's grant for `spade.grant.revoke`; unset where grants aren't made. */
  setRevoker(revoke: () => Promise<boolean>): void {
    this.revoker = revoke;
  }
  /** Revokes Spade's grant; false when there was none live or this daemon makes none. */
  revokeGrant(): Promise<boolean> {
    return this.revoker?.() ?? Promise.resolve(false);
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
    if (this.hidden) return undefined;
    return this.live && { connection: this.live.connection, generation: this.live.generation };
  }
  /** Follows `spade.enabled`: watching and polling run only while it is on. */
  setEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.facts.enabled) return;
    this.facts = { ...this.facts, enabled };
    this.silentSince = undefined;
    this.misses = 0;
    if (enabled) {
      // A change to server.json or the token is worth a look now, whatever the backoff.
      this.stopWatch = this.options.runtime.watch(this.options.dataDir, () => {
        this.misses = 0;
        void this.refresh();
      });
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
    this.misses = 0;
    void this.refresh();
  }
  /**
   * Looks again now. A call during a look waits for one more look after it, and calls made
   * meanwhile share that one.
   */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.next) return this.next;
    if (this.running) {
      this.next = this.running.then(() => {
        this.next = undefined;
        return this.refresh();
      });
      return this.next;
    }
    this.running = this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stopWatch?.();
    this.cancelTimer?.();
    await this.next;
    await this.running;
    this.leave();
    this.listeners.clear();
    this.endings.clear();
    this.arrivals.clear();
  }

  private async look(): Promise<void> {
    const { runtime, dataDir } = this.options;
    if (!this.facts.enabled) return this.apply(this.facts, undefined);
    const text = await runtime.readText(join(dataDir, "server.json"));
    const read = text === undefined ? undefined : readSpadeServerFile(text);
    const named = read?.ok ? read.endpoint : undefined;
    // A server.json left by a Spade that is gone names nothing.
    const endpoint = named && runtime.alive(named.pid) ? named : undefined;
    const tokenText = endpoint && (await runtime.readText(join(dataDir, "token")));
    const token = tokenText ? readTokenFile(tokenText) : undefined;
    // Only a nonce goes out; the token stays here until the answer proves it is Spade's.
    const nonce = runtime.nonce();
    const answer =
      endpoint && token
        ? await runtime
            .health(endpoint, nonce, AbortSignal.timeout(this.options.healthTimeoutMs ?? 2000))
            .catch(() => undefined)
        : undefined;
    const healthy = answer !== undefined;
    // `checkSpadeProof` from @ace/service/spade, the same check `proveSpade` makes.
    const proof =
      answer && token
        ? answer.proof === undefined
          ? "missing"
          : checkSpadeProof(token, nonce, answer.proof)
            ? "ok"
            : "wrong"
        : undefined;
    // The service manager is asked only when Spade isn't answering as the instance already seen
    // running: one that keeps proving itself is still the running service, and launchctl or
    // systemctl would be a process every few seconds for nothing.
    const same =
      endpoint && token && this.live?.key === `${endpoint.pid}@${endpoint.port}:${token}`;
    const service =
      same && proof === "ok" && this.facts.service === "running"
        ? "running"
        : await runtime.serviceState().catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
    const now = runtime.now();
    if (this.closed || !this.facts.enabled) return;
    const facts: SpadeFacts = {
      ...this.facts,
      service,
      endpoint: endpoint && token ? endpoint : undefined,
      healthy,
      proof,
      silentForMs: 0,
      setup: answer?.setup,
      platform: runtime.platform,
    };
    if (spadeAnswering(facts) || service !== "running") this.silentSince = undefined;
    else this.silentSince ??= now;
    facts.silentForMs = this.silentSince === undefined ? 0 : now - this.silentSince;
    const answering = spadeAnswering(facts) && endpoint && token ? { endpoint, token } : undefined;
    this.apply(facts, answering);
    const poll = { ...defaultPoll, ...this.options.pollMs };
    // Starting up (installing, or within the start grace) is looked at often; a Spade that stays
    // down is looked at less and less, and the directory watch still wakes the link at once.
    const settling =
      facts.installing || (this.silentSince !== undefined && facts.silentForMs < spadeStartGraceMs);
    if (answering || settling) this.misses = 0;
    else this.misses++;
    const wait = answering
      ? poll.ready
      : Math.min(poll.waiting * 2 ** Math.max(0, this.misses - 1), poll.idle);
    this.cancelTimer?.();
    this.cancelTimer = runtime.after(wait, () => {
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
