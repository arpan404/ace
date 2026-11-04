import type { PathRoute, WelcomedPath } from "./path-handshake.ts";
import {
  afterFailure,
  afterSuccess,
  pathTiming,
  pingEvery,
  raceOrder,
  smoothRtt,
  standbyFor,
  standbyRetryMs,
  switchVerdict,
  upgradeCandidates,
  type PathHealth,
  type PlannedPath,
} from "./path-plan.ts";
import { racingTransport, type MachineRoute } from "./path-race.ts";
import { GRANT_EXPIRED_CLOSE, GRANT_RETRY_MS } from "./grant-keeper.ts";
export type { MachineRoute } from "./path-race.ts";
import { ClientError, type ConnectionState, type Scheduler } from "./types.ts";
import type { Selection } from "./observable.ts";

/** What the manager needs from the connection it moves (`Connection`). */
export interface PathConnection {
  readonly state: ConnectionState;
  readonly heard: number;
  openBeside(route: PathRoute): Promise<WelcomedPath>;
  swap(path: WelcomedPath, mode: "switch" | "failover"): boolean;
  ping(): Promise<void>;
  failover(reason: string): void;
  setStandby(standby: PathStandby | undefined): void;
  onWrongHost(refused: (() => void) | undefined): void;
}

/** Where a dropped active path fails over to; `used` hears the active path's close code. */
export interface PathStandby {
  path(): WelcomedPath | undefined;
  used(code: number): void;
}

/**
 * Whether a failure was the account grant's, not the path's: `close` for a socket closed as
 * its grant ran out (4014), `credential` for a credential that couldn't be fetched or was
 * refused. Undefined for anything else.
 */
function grantTrouble(cause: unknown): "close" | "credential" | undefined {
  if (cause === GRANT_EXPIRED_CLOSE) return "close";
  if (cause instanceof ClientError && (cause.code === "auth" || cause.code === "machine_code"))
    return "credential";
  return undefined;
}

export interface MultipathOptions {
  /** The paths this platform can use securely right now, from what the machine advertised. */
  routes(): readonly MachineRoute[];
  scheduler: Scheduler;
  now(): number;
  /** High resolution, for the swap's duration (`performance.now`); `now` when absent. */
  clock?(): number;
  /** Whether the app is in front: pings are 5 s apart then, 15 s otherwise. */
  visible?(): boolean;
  /** The path that won last time, tried first. */
  lastWinner?: string | undefined;
  /** A path won a race or was switched to: remember it for next time. */
  chosen?(path: PlannedPath): void;
  /** A path reached another machine: it is dropped and the person should be told. */
  mismatch?(path: PlannedPath): void;
  report?(event: string, data: Record<string, string | number | boolean>): void;
  /**
   * Hear network changes (the browser's `online`), each a cue to check better paths; returns
   * how to stop. Stopped when the manager closes.
   */
  watchNetwork?(changed: () => void): () => void;
}

/**
 * Keeps one machine's connection on its fastest working path (ADR 0114): races the paths on
 * every connect, pings the active one, probes better ones, keeps a relay warm while on the LAN
 * or Tailscale, and moves make-before-break. Decisions come from `path-plan.ts`; this is the
 * shell that runs them on timers.
 */
const noop = () => {};
/** What a standby tells the daemon once welcomed: an idle socket, not one showing alerts. */
const standbyPresence = {
  type: "presence.update",
  threadId: null,
  inputAgeMs: 86_400_000,
  appState: "background",
} as const;

export class Multipath {
  #options: MultipathOptions;
  #health = new Map<string, PathHealth>();
  #listeners = new Set<() => void>();
  #connection: PathConnection | undefined;
  #stopState: (() => void) | undefined;
  #stopNetwork: (() => void) | undefined;
  /** The path the race picked for the connecting attempt. */
  #racing: MachineRoute | undefined;
  #active: MachineRoute | undefined;
  #switchedAt: number | undefined;
  #standby: { route: MachineRoute; path: WelcomedPath; stop: () => void } | undefined;
  #timers: (() => void)[] = [];
  #switching = false;
  #openingStandby = false;
  #lastWinner: string | undefined;
  /** Paths that reached another daemon: never used again by this manager. */
  #refused = new Set<string>();
  #closed = false;
  /** How long the last swap held the client, in ms. */
  lastSwapMs: number | undefined;
  constructor(options: MultipathOptions) {
    this.#options = options;
    this.#lastWinner = options.lastWinner;
  }
  /** The path the connection uses now; undefined while connecting. */
  get active(): PlannedPath | undefined {
    return this.#active?.path;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** The connection's route: every attempt races the paths, best and last winner first. */
  route(): PathRoute {
    return {
      transport: () => {
        const order = raceOrder(
          this.#routes().map((route) => route.path),
          this.#health,
          this.#options.now(),
          this.#lastWinner,
        );
        const routes = this.#routes();
        return racingTransport({
          routes: order.flatMap((path) => routes.filter((route) => route.path.key === path.key)),
          scheduler: this.#options.scheduler,
          won: (route) => {
            this.#racing = route;
          },
          failed: (route) => this.#failed(route),
        });
      },
      credential: () =>
        this.#racing
          ? this.#racing.credential()
          : Promise.reject(new ClientError("offline", "No path answered")),
    };
  }
  /** Start moving `connection`, whose state `state` reports. */
  attach(connection: PathConnection, state: Selection<ConnectionState>): void {
    this.#stopState?.();
    this.#connection = connection;
    connection.setStandby({
      path: () => this.#standby?.path,
      used: (code) => this.#failedOver(code),
    });
    connection.onWrongHost(() => {
      if (this.#racing) this.#refuse(this.#racing);
    });
    this.#stopState = state.subscribe(() => this.#changed());
    this.#stopNetwork ??= this.#options.watchNetwork?.(() => this.networkChanged());
    this.#changed();
  }
  /** The network changed (online, offline, another connection): check better paths now. */
  networkChanged(): void {
    void this.#checkUpgrades();
  }
  /** Woken from sleep: the active path may be gone and a better one may be back. */
  wake(): void {
    void this.#checkUpgrades();
  }
  close(): void {
    this.#closed = true;
    this.#stopState?.();
    this.#stopNetwork?.();
    this.#stopNetwork = undefined;
    this.#stopLoops();
    this.#connection?.setStandby(undefined);
    this.#connection?.onWrongHost(undefined);
  }

  /** The paths the platform offers, less any that reached another daemon. */
  #routes(): readonly MachineRoute[] {
    return this.#options.routes().filter((route) => !this.#refused.has(route.path.key));
  }
  /** `route` reached another machine: drop it for good and say so. */
  #refuse(route: MachineRoute): void {
    this.#refused.add(route.path.key);
    if (this.#racing === route) this.#racing = undefined;
    this.#options.report?.("path.mismatch", { path: route.path.kind });
    this.#options.mismatch?.(route.path);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
  #changed(): void {
    const connection = this.#connection;
    if (!connection || this.#closed) return;
    if (connection.state !== "ready") {
      if (this.#active || this.#standby) {
        this.#stopLoops();
        this.#active = undefined;
        this.#emit();
      }
      return;
    }
    if (this.#active || !this.#racing) return;
    this.#settle(this.#racing);
  }
  /** `route` carries the connection now: remember it and start watching it. */
  #settle(route: MachineRoute): void {
    this.#stopLoops();
    this.#active = route;
    this.#lastWinner = route.path.key;
    this.#health.set(route.path.key, afterSuccess(this.#healthOf(route)));
    this.#options.chosen?.(route.path);
    this.#emit();
    this.#schedulePing();
    this.#scheduleUpgrade();
    void this.#openStandby();
  }
  #healthOf(route: MachineRoute): PathHealth {
    return this.#health.get(route.path.key) ?? { failures: 0, restUntil: 0 };
  }
  #failed(route: MachineRoute): void {
    this.#health.set(route.path.key, afterFailure(this.#healthOf(route), this.#options.now()));
  }
  #later(delayMs: number, run: () => void): void {
    const cancel = this.#options.scheduler.set(delayMs, () => {
      this.#timers = this.#timers.filter((timer) => timer !== cancel);
      run();
    });
    this.#timers.push(cancel);
  }
  #stopLoops(): void {
    for (const cancel of this.#timers.splice(0)) cancel();
    this.#standby?.stop();
    this.#standby?.path.close();
    this.#standby = undefined;
  }

  /** Ping the active path; a pong sharpens its round trip, silence for 2 s fails it over. */
  #schedulePing(): void {
    this.#later(pingEvery(this.#options.visible?.() ?? true), () => {
      const connection = this.#connection;
      const route = this.#active;
      if (!connection || !route || connection.state !== "ready") return;
      const sentAt = this.#options.now();
      const heard = connection.heard;
      let answered = false;
      void connection.ping().then(() => {
        answered = true;
        if (this.#active !== route) return;
        const health = this.#healthOf(route);
        this.#health.set(route.path.key, {
          ...health,
          rttMs: smoothRtt(health.rttMs, this.#options.now() - sentAt),
        });
      });
      this.#later(pathTiming.pongDeadlineMs, () => {
        if (this.#active !== route) return;
        // Anything heard proves the path alive; a pong queued behind a busy stream is late.
        if (answered || connection.heard > heard) {
          this.#schedulePing();
          return;
        }
        this.#failed(route);
        this.#options.report?.("path.pong_missed", { path: route.path.kind });
        connection.failover("Path missed its pong");
      });
    });
  }
  #scheduleUpgrade(): void {
    this.#later(pathTiming.upgradeProbeMs, () => {
      void this.#checkUpgrades().finally(() => {
        if (this.#active) this.#scheduleUpgrade();
      });
    });
  }
  /** Probe better paths, best first, and switch to the first one worth it. */
  async #checkUpgrades(): Promise<void> {
    const active = this.#active;
    const connection = this.#connection;
    if (!active || !connection || this.#switching || this.#closed) return;
    const routes = this.#routes();
    const candidates = upgradeCandidates(
      routes.map((route) => route.path),
      active.path,
      this.#health,
      this.#options.now(),
    );
    for (const candidate of candidates) {
      const route = routes.find((entry) => entry.path.key === candidate.key);
      if (!route?.probe) continue;
      let rttMs: number;
      try {
        rttMs = await route.probe();
      } catch {
        this.#failed(route);
        continue;
      }
      if (this.#active !== active) return;
      const health = this.#healthOf(route);
      const smoothed = smoothRtt(health.rttMs, rttMs);
      this.#health.set(route.path.key, { ...health, rttMs: smoothed });
      const verdict = switchVerdict({
        active: { ...active.path, rttMs: this.#healthOf(active).rttMs },
        candidate: { ...route.path, rttMs: smoothed },
        now: this.#options.now(),
        switchedAt: this.#switchedAt,
      });
      if (verdict === "hold") return;
      if (verdict === "switch") {
        await this.switchTo(route);
        return;
      }
    }
  }
  /**
   * Move to `route` make-before-break: open it beside the active path with the same
   * credential, wait for the same machine's welcome, then swap. Any failure before the swap
   * closes only the new path. Resolves true once the connection uses `route`.
   */
  async switchTo(route: MachineRoute): Promise<boolean> {
    const connection = this.#connection;
    const from = this.#active;
    if (!connection || !from || this.#switching || connection.state !== "ready") return false;
    this.#switching = true;
    try {
      let opened: WelcomedPath;
      try {
        opened = await connection.openBeside(route);
      } catch (error) {
        this.#failed(route);
        if (error instanceof ClientError && error.code === "identity") this.#refuse(route);
        return false;
      }
      if (this.#active !== from || this.#closed) {
        opened.close();
        return false;
      }
      const clock = this.#options.clock ?? this.#options.now;
      const started = clock();
      const swapped = connection.swap(opened, "switch");
      const held = clock() - started;
      if (!swapped) {
        opened.close();
        return false;
      }
      this.lastSwapMs = held;
      this.#switchedAt = this.#options.now();
      this.#options.report?.("path.switched", {
        from: from.path.kind,
        to: route.path.kind,
        swapMs: held,
      });
      this.#settle(route);
      return true;
    } finally {
      this.#switching = false;
    }
  }
  /**
   * Keep the best relay authenticated and idle while on the LAN or Tailscale. One that fails
   * rests, and another relay, or the same one once its rest ends, takes its place.
   */
  async #openStandby(): Promise<void> {
    const active = this.#active;
    const connection = this.#connection;
    if (!active || !connection || this.#standby || this.#openingStandby || this.#closed) return;
    const routes = this.#routes();
    const paths = routes.map((route) => route.path);
    const now = this.#options.now();
    const planned = standbyFor(paths, active.path, this.#health, now);
    const route = planned && routes.find((entry) => entry.path.key === planned.key);
    if (!route) {
      const retryMs = standbyRetryMs(paths, active.path, this.#health, now);
      if (retryMs !== undefined) this.#later(retryMs, () => void this.#openStandby());
      return;
    }
    let path: WelcomedPath;
    this.#openingStandby = true;
    try {
      path = await connection.openBeside(route);
    } catch (error) {
      this.#openingStandby = false;
      this.#standbyFailed(active, route, error);
      this.#standbyAfter(active);
      return;
    }
    this.#openingStandby = false;
    if (this.#active !== active || this.#standby || this.#closed) {
      path.close();
      this.#standbyAfter(active);
      return;
    }
    // An idle standby is no place to show an alert: the daemon counts it as backgrounded.
    try {
      path.send(JSON.stringify(standbyPresence));
    } catch {
      path.close();
      this.#standbyFailed(active, route);
      return;
    }
    let stopped = false;
    let cancel: () => void = noop;
    const ping = () => {
      cancel = this.#options.scheduler.set(pathTiming.standbyPingMs, () => {
        const heard = path.heard;
        try {
          path.send(JSON.stringify({ type: "ping" }));
        } catch {
          drop();
          return;
        }
        cancel = this.#options.scheduler.set(pathTiming.pongDeadlineMs, () => {
          if (path.heard > heard) ping();
          else drop();
        });
      });
    };
    const drop = (code?: number) => {
      if (stopped || this.#standby?.path !== path) return;
      this.#standby.stop();
      path.close();
      this.#standby = undefined;
      this.#standbyFailed(active, route, code);
    };
    path.onClosed((code) => drop(code));
    this.#standby = {
      route,
      path,
      stop: () => {
        stopped = true;
        cancel();
      },
    };
    ping();
  }
  /**
   * The standby `route` failed: it rests, and a standby is sought again while still useful. A
   * failure of the account grant (`cause`: a 4014 close, or a refused or unavailable
   * credential) is no fault of the route: it doesn't rest, and the next try waits a little
   * when the credential itself was the trouble.
   */
  #standbyFailed(active: MachineRoute, route: MachineRoute, cause?: unknown): void {
    const grant = grantTrouble(cause);
    if (!grant) this.#failed(route);
    if (this.#active === active && !this.#closed)
      this.#later(grant === "credential" ? GRANT_RETRY_MS : 0, () => void this.#openStandby());
  }
  /**
   * A standby opening for `opened` settled after the connection moved to another path: the
   * new active path may want a standby of its own, which this opening held back.
   */
  #standbyAfter(opened: MachineRoute): void {
    if (!this.#closed && this.#active && this.#active !== opened) void this.#openStandby();
  }
  /** The connection failed over onto the standby: it is the active path now. */
  #failedOver(code: number): void {
    const standby = this.#standby;
    if (!standby) return;
    standby.stop();
    this.#standby = undefined;
    // A grant that ran out closes a socket on any path: the path itself is fine.
    if (this.#active && code !== GRANT_EXPIRED_CLOSE) this.#failed(this.#active);
    this.#switchedAt = this.#options.now();
    this.#settle(standby.route);
  }
}
