import {
  StderrLog,
  phaseHealth,
  type ExitCause,
  type MediaCapabilities,
  type MediaExit,
  type MediaLog,
  type MediaPhase,
  type MediaSnapshot,
  type MediaStats,
} from "./diagnostics.ts";
import {
  InFlight,
  isRevocation,
  revocationRule,
  type GrantRule,
  type Revocation,
  type RevocationResult,
} from "./grants.ts";
import { LaneHealth } from "./health.ts";
import {
  authenticateLane,
  controlFrameReader,
  egressFrameReader,
  LaneWriter,
  type ByteSource,
  type LaneSocket,
  type SocketLane,
} from "./lanes.ts";
import {
  crashLoop,
  mediaWanted,
  restartDelay,
  supervisionTimings,
  type MediaHealth,
  type MediaSettings,
} from "./supervision-policy.ts";
import { secureRandomBytes, type MediaClock, type MediaHost } from "./supervisor-host.ts";
import { controlLane, decodeFromMedia, type FromMedia, type ToMedia } from "./wire.ts";

export * from "./diagnostics.ts";
export * from "./grants.ts";
export * from "./media-binary.ts";
export * from "./supervision-policy.ts";
export * from "./supervisor-host.ts";

/**
 * The daemon's owner of the ace-media process (docs/media/plan.md, "Supervision"): lazy start,
 * lane authentication, health, revocation deadlines, restart with backoff, and failing in-flight
 * work when the process goes. The daemon's own state is the truth; after every start it replays
 * that state through `replay`.
 */

type Ready = Extract<FromMedia, { type: "ready" }>;
type Listen = Extract<ToMedia, { type: "listen" }>;

export type MediaSupervisorOptions = {
  version: string;
  binary: string;
  runtimeDir: string;
  dataDir: string;
  settings: () => MediaSettings;
  host: MediaHost;
  clock: MediaClock;
  /** Backoff jitter only. */
  random: () => number;
  /** The lane secret's source; the platform CSPRNG unless a test injects one. */
  randomBytes?: (length: number) => Uint8Array;
  listen: () => { message: Listen; payload: Uint8Array };
  /** Called once both lanes are up: send every open source and recording again. */
  replay: () => void;
  onMessage: (message: FromMedia, payload: Uint8Array) => void;
  onEgress: (frame: Uint8Array) => void;
  onExit?: (exit: MediaExit) => void;
  log: MediaLog;
};

type Run = {
  child: { pid?: number | undefined; kill(): void };
  secret: Uint8Array;
  normal: LaneWriter;
  priority?: LaneWriter;
  sockets: LaneSocket[];
  ready?: Ready;
  up: boolean;
  dead: boolean;
  stopping: boolean;
  cause?: ExitCause;
  cancels: Set<() => void>;
  health: LaneHealth;
  healthySince?: number;
  stats?: MediaStats;
  revocations: Map<string, (result: RevocationResult) => void>;
  rules: GrantRule[];
  work: InFlight;
  stderr: StderrLog;
};

export class MediaSupervisor {
  readonly #options: MediaSupervisorOptions;
  #run: Run | undefined;
  #needs = 0;
  #failures: number[] = [];
  #attempt = 0;
  #restartTimer: (() => void) | undefined;
  #idleTimer: (() => void) | undefined;
  #unavailable: { until?: number; reason: string; cancel?: () => void } | undefined;
  #lastExit: MediaSnapshot["lastExit"];
  #disposed = false;

  constructor(options: MediaSupervisorOptions) {
    this.#options = options;
  }

  /**
   * Marks a use of ace-media (a source, viewer, recording or still) and starts it if needed.
   * Returns the release; 60 s after the last release ace-media is shut down. A need that comes
   * during that shutdown starts a fresh process once the old one has exited. While the setting
   * gate is closed this does nothing.
   */
  need(): () => void {
    if (this.#disposed || !mediaWanted(this.#options.settings())) return () => {};
    this.#needs++;
    this.#idleTimer?.();
    this.#idleTimer = undefined;
    if (!this.#run && !this.#restartTimer && !this.#unavailable) this.#start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#needs--;
      if (this.#needs === 0) this.#scheduleIdle();
    };
  }

  health(): MediaHealth {
    return this.snapshot().health;
  }

  /** What `ready` reported for the running process. */
  capabilities(): MediaCapabilities | undefined {
    return this.#accepting() ? this.#run?.ready?.capabilities : undefined;
  }

  snapshot(): MediaSnapshot {
    const run = this.#run;
    const phase = this.#phase();
    return {
      health: phaseHealth(phase),
      phase,
      pid: run?.ready?.pid ?? run?.child.pid,
      capabilities: this.capabilities(),
      stats: run?.stats,
      recentFailures: crashLoop(this.#failures, this.#options.clock.now()).recent.length,
      unavailableUntil: this.#unavailable?.until,
      unavailableReason: this.#unavailable?.reason,
      lastExit: this.#lastExit,
    };
  }

  /**
   * Sends one message on its lane. False when ace-media isn't running with both lanes up, is
   * shutting down, or the message is a grant a revocation already covers; the caller then uses
   * its fallback (the replay after the next start covers sources and recordings). A secret
   * payload is the supervisor's from here on and is zeroed once written or dropped.
   */
  send(message: ToMedia, payload: Uint8Array = new Uint8Array(0)): boolean {
    if (message.type === "shutdown" || isRevocation(message))
      throw new Error(`Use revoke() or the idle shutdown for ${message.type}`);
    const run = this.#run;
    const writer = controlLane(message.type) === "priority" ? run?.priority : run?.normal;
    if (!run || !this.#accepting() || !writer || run.rules.some((rule) => rule(message))) {
      payload.fill(0);
      return false;
    }
    run.work.sent(message);
    writer.send(message, payload);
    return true;
  }

  /**
   * Revokes on the priority lane at once, whatever the normal lane holds, and drops queued grants
   * it covers. Resolves when ace-media answers, or when the process is gone: with no answer
   * within 250 ms the process is killed, as it is whenever a lane drops. Before the lanes are up
   * no grant has been sent, so there is nothing to revoke (`not-running`).
   */
  revoke(message: Revocation): Promise<RevocationResult> {
    const run = this.#run;
    if (!run || run.dead || !run.ready) return Promise.resolve("not-running");
    const rule = revocationRule(message);
    run.rules.push(rule);
    run.normal.drop(rule);
    const priority = run.priority;
    if (!run.up || !priority) return Promise.resolve("not-running");
    return new Promise((resolve) => {
      const cancel = this.#timer(run, supervisionTimings.revocationMs, () =>
        this.#kill(run, "revocation-timeout"),
      );
      run.revocations.set(message.id, (result) => {
        cancel();
        resolve(result);
      });
      priority.send(message);
    });
  }

  /** Kills ace-media and never restarts it. */
  dispose(): void {
    this.#disposed = true;
    this.#restartTimer?.();
    this.#idleTimer?.();
    this.#unavailable?.cancel?.();
    if (this.#run) this.#kill(this.#run, "disposed");
  }

  #accepting(): boolean {
    const run = this.#run;
    return run !== undefined && run.up && !run.dead && !run.stopping;
  }

  #phase(): MediaPhase {
    const run = this.#run;
    if (run) return run.stopping ? "stopping" : run.up ? "running" : "starting";
    if (this.#unavailable) return "unavailable";
    if (this.#restartTimer) return "backoff";
    return mediaWanted(this.#options.settings()) ? "idle" : "disabled";
  }

  #start(): void {
    const { host, binary, version, runtimeDir, dataDir, clock, log } = this.#options;
    let child: ReturnType<MediaHost["spawn"]>;
    try {
      child = host.spawn(binary);
    } catch (error) {
      log("error", "ace-media failed to start", { error: String(error) });
      this.#afterExit(undefined, { cause: "crashed", code: null, signal: null });
      return;
    }
    const secret = (this.#options.randomBytes ?? secureRandomBytes)(32);
    const run: Run = {
      child,
      secret,
      normal: new LaneWriter("normal", child.stdin, () => this.#kill(run, "lane-closed")),
      sockets: [],
      up: false,
      dead: false,
      stopping: false,
      cancels: new Set(),
      health: new LaneHealth(
        (ms, callback) => this.#timer(run, ms, callback),
        (cause) => this.#kill(run, cause),
      ),
      revocations: new Map(),
      rules: [],
      work: new InFlight(),
      stderr: new StderrLog(() => clock.now(), log),
    };
    this.#run = run;
    this.#read(run, child.stdout, controlFrameReader("normal"), (frame) =>
      this.#onFrame(run, frame, "normal"),
    );
    child.stderr.onData((chunk) => run.stderr.push(chunk));
    void child.exited.then((exit) => {
      // A process dying on its own closes its lanes just before it exits: it crashed.
      const killed = exit.code === null && (exit.signal === "SIGKILL" || exit.signal === "SIGTERM");
      const own = run.cause === "lane-closed" && !killed;
      this.#afterExit(run, { cause: own ? "crashed" : (run.cause ?? "crashed"), ...exit });
    });
    this.#timer(run, supervisionTimings.readyMs, () => {
      if (!run.up) this.#kill(run, "ready-timeout");
    });
    run.normal.send(
      {
        type: "init",
        protocol: 1,
        version,
        runtimeDir,
        dataDir,
        settings: this.#options.settings(),
      },
      secret.slice(),
    );
  }

  #onFrame(run: Run, frame: Uint8Array, lane: "normal" | "priority"): void {
    if (run !== this.#run || run.dead) return;
    let decoded: ReturnType<typeof decodeFromMedia>;
    try {
      decoded = decodeFromMedia(frame, lane);
    } catch (error) {
      this.#options.log("error", "ace-media sent an invalid frame", { lane, error: String(error) });
      return this.#kill(run, "protocol");
    }
    const { message, payload } = decoded;
    switch (message.type) {
      case "ready":
        if (run.ready) return this.#kill(run, "protocol");
        run.ready = message;
        if (message.version !== this.#options.version) {
          this.#options.log("error", "ace-media version mismatch", {
            expected: this.#options.version,
            actual: message.version,
          });
          return this.#kill(run, "version-mismatch");
        }
        void this.#openLanes(run, message.control.socket);
        return;
      case "pong":
        run.health.pong(message.id);
        run.stats = message.stats;
        return;
      case "revoked":
      case "closed":
        run.revocations.get(message.id)?.("answered");
        run.revocations.delete(message.id);
        return;
      case "log":
        this.#options.log(message.level, `ace-media: ${message.message}`, message.fields);
        return;
    }
    run.work.received(message);
    this.#options.onMessage(message, payload);
  }

  async #openLanes(run: Run, path: string): Promise<void> {
    try {
      const [priority, egress] = await Promise.all(
        (["priority", "egress"] as const).map((lane) => this.#authenticate(run, lane, path)),
      );
      if (run.dead || !priority || !egress) return;
      run.secret.fill(0);
      run.priority = new LaneWriter("priority", priority.socket, () =>
        this.#kill(run, "lane-closed"),
      );
      this.#read(run, priority.frames, controlFrameReader("priority"), (frame) =>
        this.#onFrame(run, frame, "priority"),
      );
      this.#read(run, egress.frames, egressFrameReader(), (frame) => {
        if (run === this.#run && !run.dead) this.#options.onEgress(frame);
      });
      run.up = true;
      run.healthySince = this.#options.clock.now();
      const listen = this.#options.listen();
      run.normal.send(listen.message, listen.payload);
      this.#options.replay();
      this.#ping(run);
    } catch (error) {
      if (run.dead) return;
      this.#options.log("error", "ace-media lanes failed", { error: String(error) });
      this.#kill(run, "lane-closed");
    }
  }

  /**
   * Connects one socket lane and authenticates it. Its close is watched from the moment it
   * connects, so a lane that drops while the other is still authenticating ends the run.
   */
  async #authenticate(
    run: Run,
    lane: SocketLane,
    path: string,
  ): Promise<{ socket: LaneSocket; frames: ByteSource } | undefined> {
    const socket = await this.#options.host.connect(path);
    run.sockets.push(socket);
    socket.onEnd(() => {
      // During an idle shutdown ace-media closes its lanes itself; the grace timer still runs.
      if (!run.dead && !run.stopping) this.#kill(run, "lane-closed");
    });
    if (run.dead) {
      socket.destroy();
      return undefined;
    }
    return { socket, frames: await authenticateLane(socket, lane, run.secret) };
  }

  #read(
    run: Run,
    source: ByteSource,
    reader: { push(chunk: Uint8Array): Uint8Array[] },
    onFrame: (frame: Uint8Array) => void,
  ): void {
    source.onData((chunk) => {
      if (run.dead) return;
      let frames: Uint8Array[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        this.#options.log("error", "ace-media sent invalid framing", { error: String(error) });
        return this.#kill(run, "protocol");
      }
      for (const frame of frames) onFrame(frame);
    });
  }

  #ping(run: Run): void {
    this.#timer(run, supervisionTimings.pingMs, () => {
      const id = run.health.tick(run.normal.progress());
      if (run.dead) return;
      if (id) run.normal.send({ type: "ping", id }, undefined, () => run.health.written(id));
      this.#ping(run);
    });
  }

  #scheduleIdle(): void {
    this.#idleTimer?.();
    this.#idleTimer = this.#options.clock.setTimeout(() => {
      this.#idleTimer = undefined;
      const run = this.#run;
      if (this.#needs > 0 || !run || run.dead || run.stopping) return;
      if (!run.up || !run.priority) return this.#kill(run, "idle");
      run.stopping = true;
      run.cause = "idle";
      const graceMs = supervisionTimings.shutdownGraceMs;
      run.priority.send({ type: "shutdown", graceMs });
      this.#timer(run, graceMs, () => this.#kill(run, "idle"));
    }, supervisionTimings.idleMs);
  }

  #timer(run: Run, ms: number, callback: () => void): () => void {
    const cancel = this.#options.clock.setTimeout(() => {
      run.cancels.delete(cancel);
      if (!run.dead) callback();
    }, ms);
    run.cancels.add(cancel);
    return () => {
      cancel();
      run.cancels.delete(cancel);
    };
  }

  #kill(run: Run, cause: ExitCause): void {
    if (run.dead) return;
    // The first cause wins, except that a failure during an idle shutdown is still a failure.
    if (!run.cause || run.cause === "idle") run.cause = cause;
    this.#close(run);
    run.child.kill();
  }

  /** Stops every timer and lane of a run that is going away; nothing more reaches it. */
  #close(run: Run): void {
    run.dead = true;
    run.up = false;
    for (const cancel of run.cancels) cancel();
    run.cancels.clear();
    run.secret.fill(0);
    run.normal.close();
    run.priority?.close();
    for (const socket of run.sockets) socket.destroy();
  }

  #afterExit(
    run: Run | undefined,
    exit: { cause: ExitCause; code: number | null; signal: string | null },
  ): void {
    if (run) {
      if (run !== this.#run) return;
      this.#close(run);
      this.#run = undefined;
      for (const resolve of run.revocations.values()) resolve("killed");
      run.revocations.clear();
    }
    const now = this.#options.clock.now();
    const permanent = exit.code === 2 || exit.cause === "version-mismatch";
    const failure = exit.cause !== "idle" && exit.cause !== "disposed";
    if (
      run?.healthySince !== undefined &&
      now - run.healthySince >= supervisionTimings.healthyResetMs
    )
      this.#attempt = 0;
    this.#lastExit = { ...exit, stderr: [...(run?.stderr.lines ?? [])] };
    let restartInMs: number | undefined;
    const wanted = this.#needs > 0 && !this.#disposed;
    if (permanent) {
      this.#unavailable = {
        reason: exit.code === 2 ? "protocol or version mismatch (exit 2)" : "version mismatch",
      };
    } else if (failure) {
      this.#attempt++;
      const loop = crashLoop([...this.#failures, now], now);
      this.#failures = loop.recent;
      if (loop.looping) this.#markUnavailable(now);
      else if (wanted) {
        restartInMs = restartDelay(this.#attempt, this.#options.random());
        this.#restartTimer = this.#options.clock.setTimeout(() => {
          this.#restartTimer = undefined;
          if (this.#needs > 0 && !this.#disposed) this.#start();
        }, restartInMs);
      }
    } else if (wanted) this.#start();
    if (failure) this.#options.log("warn", "ace-media exited", { ...exit, restartInMs });
    const work = run?.work.list() ?? { stills: [], connections: [], sources: [], recordings: [] };
    this.#options.onExit?.({ ...exit, ...work, failure, restartInMs });
  }

  #markUnavailable(now: number): void {
    const cancel = this.#options.clock.setTimeout(() => {
      this.#unavailable = undefined;
      this.#failures = [];
      this.#attempt = 0;
      if (this.#needs > 0 && !this.#disposed) this.#start();
    }, supervisionTimings.unavailableMs);
    this.#unavailable = {
      until: now + supervisionTimings.unavailableMs,
      reason: "crash loop",
      cancel,
    };
  }
}
