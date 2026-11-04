import type { PathRoute, WelcomedPath } from "./path-handshake.ts";
import {
  afterFailure,
  afterSuccess,
  pathTiming,
  pingEvery,
  raceOrder,
  smoothRtt,
  standbyFor,
  switchVerdict,
  upgradeCandidates,
  type PathHealth,
  type PlannedPath,
} from "./path-plan.ts";
import { racingTransport, type MachineRoute } from "./path-race.ts";
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
  setStandby(standby: { path(): WelcomedPath | undefined; used(): void } | undefined): void;
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
}

/**
 * Keeps one machine's connection on its fastest working path (ADR 0114): races the paths on
 * every connect, pings the active one, probes better ones, keeps a relay warm while on the LAN
 * or Tailscale, and moves make-before-break. Decisions come from `path-plan.ts`; this is the
 * shell that runs them on timers.
 */
const noop = () => {};

export class Multipath {
  #options: MultipathOptions;
  #health = new Map<string, PathHealth>();
  #listeners = new Set<() => void>();
  #connection: PathConnection | undefined;
  #stopState: (() => void) | undefined;
  /** The path the race picked for the connecting attempt. */
  #racing: MachineRoute | undefined;
  #active: MachineRoute | undefined;
  #switchedAt: number | undefined;
  #standby: { route: MachineRoute; path: WelcomedPath; stop: () => void } | undefined;
  #timers: (() => void)[] = [];
  #switching = false;
  #lastWinner: string | undefined;
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
          this.#options.routes().map((route) => route.path),
          this.#health,
          this.#options.now(),
          this.#lastWinner,
        );
        const routes = this.#options.routes();
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
      used: () => this.#failedOver(),
    });
    this.#stopState = state.subscribe(() => this.#changed());
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
    this.#stopLoops();
    this.#connection?.setStandby(undefined);
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
    const routes = this.#options.routes();
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
        if (error instanceof ClientError && error.code === "identity")
          this.#options.mismatch?.(route.path);
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
  /** Keep the best relay authenticated and idle while on the LAN or Tailscale. */
  async #openStandby(): Promise<void> {
    const active = this.#active;
    const connection = this.#connection;
    if (!active || !connection || this.#standby) return;
    const routes = this.#options.routes();
    const planned = standbyFor(
      routes.map((route) => route.path),
      active.path,
    );
    const route = planned && routes.find((entry) => entry.path.key === planned.key);
    if (!route) return;
    let path: WelcomedPath;
    try {
      path = await connection.openBeside(route);
    } catch {
      this.#failed(route);
      return;
    }
    if (this.#active !== active || this.#standby || this.#closed) {
      path.close();
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
    const drop = () => {
      if (stopped || this.#standby?.path !== path) return;
      this.#failed(route);
      this.#standby.stop();
      path.close();
      this.#standby = undefined;
    };
    path.onClosed(drop);
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
  /** The connection failed over onto the standby: it is the active path now. */
  #failedOver(): void {
    const standby = this.#standby;
    if (!standby) return;
    standby.stop();
    this.#standby = undefined;
    if (this.#active) this.#failed(this.#active);
    this.#switchedAt = this.#options.now();
    this.#settle(standby.route);
  }
}
