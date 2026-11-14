import { join } from "node:path";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { bundleRootOfEntry } from "@ace/service/spade-layout";
import {
  authenticateLane,
  connectLane,
  controlFrameReader,
  egressFrameReader,
  LaneWriter,
  nodeByteSink,
  nodeByteSource,
  type ByteSink,
  type ByteSource,
  type LaneSocket,
  type SocketLane,
} from "./lanes.ts";
import { controlLane, decodeFromMedia, type FromMedia, type ToMedia } from "./wire.ts";

/**
 * The daemon's owner of the ace-media process (docs/media/plan.md, "Supervision"): lazy start,
 * lane authentication, health, revocation deadlines, restart with backoff, and failing in-flight
 * work when the process goes. The daemon's own state is the truth; after every start it replays
 * that state through `replay`.
 */

type Message<T extends ToMedia["type"]> = Extract<ToMedia, { type: T }>;
type Ready = Extract<FromMedia, { type: "ready" }>;
type Stats = Extract<FromMedia, { type: "pong" }>["stats"];
export type MediaSettings = Message<"init">["settings"];
export type MediaCapabilities = Ready["capabilities"];
export type MediaHealth = "healthy" | "restarting" | "unavailable";
export type Revocation = Message<"revoke"> | Message<"connection.close"> | Message<"relay.close">;
/** How a revocation ended: ace-media answered, or the process (and so every socket) is gone. */
export type RevocationResult = "answered" | "killed" | "not-running";

export const supervisionTimings = {
  readyMs: 5_000,
  pingMs: 5_000,
  missedPongs: 3,
  revocationMs: 250,
  idleMs: 60_000,
  shutdownGraceMs: 5_000,
  healthyResetMs: 60_000,
  crashWindowMs: 120_000,
  crashLimit: 5,
  unavailableMs: 600_000,
} as const;

/** Restart delay after the `attempt`th consecutive failure: 0.5 s doubling to 30 s, ±20 %. */
export function restartDelay(attempt: number, random: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + 0.2 * (2 * random - 1)));
}

/** Failure times still inside the crash-loop window, and whether they reach the limit. */
export function crashLoop(failures: readonly number[], now: number) {
  const recent = failures.filter((at) => now - at < supervisionTimings.crashWindowMs);
  return { recent, looping: recent.length >= supervisionTimings.crashLimit };
}

/** The setting gate: ace-media is only ever started while some setting asks for it. */
export function mediaWanted(settings: MediaSettings): boolean {
  return Object.values(settings).some((value) => value === "auto");
}

export const legacyMediaSettings: MediaSettings = {
  recordings: "legacy",
  stills: "legacy",
  encode: "legacy",
  delivery: "legacy",
};

export function mediaBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ace-media.exe" : "ace-media";
}

/**
 * Where ace-media is: `ACE_MEDIA_PATH`; else `media/ace-media(.exe)` under the release or desktop
 * resources root the daemon's entry script runs from; else, from source, the Cargo workspace's
 * release build, then its debug build. Undefined when none exists.
 */
export function mediaBinaryPath(input: {
  env: Readonly<Record<string, string | undefined>>;
  entry: string | undefined;
  sourceRoot: string | undefined;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}): string | undefined {
  const name = mediaBinaryName(input.platform);
  const override = input.env.ACE_MEDIA_PATH?.trim();
  if (override) return override;
  if (input.entry) return join(bundleRootOfEntry(input.entry, input.exists), "media", name);
  if (!input.sourceRoot) return undefined;
  return ["release", "debug"]
    .map((profile) => join(input.sourceRoot ?? "", "native", "media", "target", profile, name))
    .find((path) => input.exists(path));
}

export interface MediaChild {
  readonly pid?: number | undefined;
  readonly stdin: ByteSink;
  readonly stdout: ByteSource;
  readonly stderr: ByteSource;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** SIGKILL, or TerminateProcess through the job object. */
  kill(): void;
}
export interface MediaHost {
  spawn(binary: string): MediaChild;
  connect(path: string): Promise<LaneSocket>;
}
export interface MediaClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

export type ExitCause =
  | "crashed"
  | "ready-timeout"
  | "version-mismatch"
  | "missed-pongs"
  | "revocation-timeout"
  | "lane-closed"
  | "protocol"
  | "idle"
  | "disposed";

/** What a process exit took with it, for the owners of that state to fail or replay. */
export type MediaExit = {
  cause: ExitCause;
  code: number | null;
  signal: string | null;
  /** Counted toward backoff and the crash-loop window. */
  failure: boolean;
  stills: string[];
  connections: string[];
  sources: string[];
  recordings: string[];
  restartInMs?: number | undefined;
};

export type MediaSnapshot = {
  health: MediaHealth;
  phase: "disabled" | "idle" | "starting" | "running" | "stopping" | "backoff" | "unavailable";
  pid?: number | undefined;
  capabilities?: MediaCapabilities | undefined;
  stats?: Stats | undefined;
  recentFailures: number;
  unavailableUntil?: number | undefined;
  unavailableReason?: string | undefined;
  lastExit?:
    | { cause: ExitCause; code: number | null; signal: string | null; stderr: string[] }
    | undefined;
};

export type MediaSupervisorOptions = {
  version: string;
  binary: string;
  runtimeDir: string;
  dataDir: string;
  settings: () => MediaSettings;
  host: MediaHost;
  clock: MediaClock;
  random: () => number;
  randomBytes: (length: number) => Uint8Array;
  listen: () => { message: Message<"listen">; payload: Uint8Array };
  /** Called once both lanes are up: send every open source and recording again. */
  replay: () => void;
  onMessage: (message: FromMedia, payload: Uint8Array) => void;
  onEgress: (frame: Uint8Array) => void;
  onExit?: (exit: MediaExit) => void;
  log: (level: "debug" | "info" | "warn" | "error", message: string, fields?: unknown) => void;
};

type Rule = (message: ToMedia) => boolean;
type Run = {
  child: MediaChild;
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
  pings: number;
  pingSeq: number;
  healthySince?: number;
  stats?: Stats;
  revocations: Map<string, (result: RevocationResult) => void>;
  rules: Rule[];
  stills: Set<string>;
  connections: Set<string>;
  sources: Set<string>;
  recordings: Set<string>;
  stderr: string[];
};

const stderrKept = 20;
const stderrPerSecond = 20;
const grantTypes = new Set<ToMedia["type"]>(["media.ticket", "viewer.open", "relay.keys"]);

export class MediaSupervisor {
  #run: Run | undefined;
  #needs = 0;
  #failures: number[] = [];
  #attempt = 0;
  #restartTimer: (() => void) | undefined;
  #idleTimer: (() => void) | undefined;
  #unavailable: { until?: number; reason: string; cancel?: () => void } | undefined;
  #lastExit: MediaSnapshot["lastExit"];
  #disposed = false;
  #logWindow = { start: 0, lines: 0, suppressed: 0 };

  private readonly options: MediaSupervisorOptions;

  constructor(options: MediaSupervisorOptions) {
    this.options = options;
  }

  /**
   * Marks a use of ace-media (a source, viewer, recording or still) and starts it if needed.
   * Returns the release; 60 s after the last release ace-media is shut down. While the setting
   * gate is closed this does nothing.
   */
  need(): () => void {
    if (this.#disposed || !mediaWanted(this.options.settings())) return () => {};
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
    return this.#run?.up ? this.#run.ready?.capabilities : undefined;
  }

  snapshot(): MediaSnapshot {
    const run = this.#run;
    const phase: MediaSnapshot["phase"] = run
      ? run.stopping
        ? "stopping"
        : run.up
          ? "running"
          : "starting"
      : this.#unavailable
        ? "unavailable"
        : this.#restartTimer
          ? "backoff"
          : mediaWanted(this.options.settings())
            ? "idle"
            : "disabled";
    return {
      health:
        phase === "running"
          ? "healthy"
          : phase === "disabled" || phase === "unavailable"
            ? "unavailable"
            : "restarting",
      phase,
      pid: run?.ready?.pid ?? run?.child.pid,
      capabilities: run?.up ? run.ready?.capabilities : undefined,
      stats: run?.stats,
      recentFailures: crashLoop(this.#failures, this.options.clock.now()).recent.length,
      unavailableUntil: this.#unavailable?.until,
      unavailableReason: this.#unavailable?.reason,
      lastExit: this.#lastExit,
    };
  }

  /**
   * Sends one message on its lane. False when ace-media isn't running with both lanes up, or the
   * message is a grant a revocation already covers; the caller then uses its fallback (the
   * replay after `ready` covers sources and recordings). A secret payload is the supervisor's
   * from here on and is zeroed once written or dropped.
   */
  send(message: ToMedia, payload: Uint8Array = new Uint8Array(0)): boolean {
    if (message.type === "shutdown" || isRevocation(message))
      throw new Error(`Use revoke() or the idle shutdown for ${message.type}`);
    const run = this.#run;
    const writer = controlLane(message.type) === "priority" ? run?.priority : run?.normal;
    if (!run || !run.up || run.dead || !writer || run.rules.some((rule) => rule(message))) {
      payload.fill(0);
      return false;
    }
    track(run, message);
    writer.send(message, payload);
    return true;
  }

  /**
   * Revokes on the priority lane at once, whatever the normal lane holds, and drops queued grants
   * it covers. Resolves when ace-media answers, or when the process is gone: with no answer
   * within 250 ms the process is killed, as it is whenever the priority lane drops. Before the
   * lanes are up no grant has been sent, so there is nothing to revoke (`not-running`).
   */
  revoke(message: Revocation): Promise<RevocationResult> {
    const run = this.#run;
    if (!run || run.dead || !run.ready) return Promise.resolve("not-running");
    const rule = revocationRule(message);
    run.rules.push(rule);
    run.normal.drop(rule);
    if (!run.up || !run.priority) {
      // ready came but the priority lane isn't up: no grant was sent yet, so nothing is open.
      return Promise.resolve("not-running");
    }
    return new Promise((resolve) => {
      const cancel = this.#timer(run, supervisionTimings.revocationMs, () =>
        this.#kill(run, "revocation-timeout"),
      );
      run.revocations.set(message.id, (result) => {
        cancel();
        resolve(result);
      });
      run.priority?.send(message);
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

  #start(): void {
    const { host, binary, version, runtimeDir, dataDir } = this.options;
    let child: MediaChild;
    try {
      child = host.spawn(binary);
    } catch (error) {
      this.options.log("error", "ace-media failed to start", { error: String(error) });
      this.#afterExit(undefined, { cause: "crashed", code: null, signal: null });
      return;
    }
    const secret = this.options.randomBytes(32);
    const run: Run = {
      child,
      secret,
      normal: new LaneWriter("normal", child.stdin, () => this.#kill(run, "lane-closed")),
      sockets: [],
      up: false,
      dead: false,
      stopping: false,
      cancels: new Set(),
      pings: 0,
      pingSeq: 0,
      revocations: new Map(),
      rules: [],
      stills: new Set(),
      connections: new Set(),
      sources: new Set(),
      recordings: new Set(),
      stderr: [],
    };
    this.#run = run;
    this.#read(run, child.stdout, controlFrameReader("normal"), (frame) =>
      this.#onFrame(run, frame, "normal"),
    );
    this.#stderr(run, child.stderr);
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
        settings: this.options.settings(),
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
      this.options.log("error", "ace-media sent an invalid frame", { lane, error: String(error) });
      this.#kill(run, "protocol");
      return;
    }
    const { message, payload } = decoded;
    switch (message.type) {
      case "ready":
        if (run.ready) return this.#kill(run, "protocol");
        run.ready = message;
        if (message.version !== this.options.version) {
          this.options.log("error", "ace-media version mismatch", {
            expected: this.options.version,
            actual: message.version,
          });
          return this.#kill(run, "version-mismatch");
        }
        void this.#openLanes(run, message.control.socket);
        return;
      case "pong":
        run.pings = 0;
        run.stats = message.stats;
        return;
      case "revoked":
      case "closed":
        run.revocations.get(message.id)?.("answered");
        run.revocations.delete(message.id);
        return;
      case "log":
        this.options.log(message.level, `ace-media: ${message.message}`, message.fields);
        return;
    }
    settle(run, message);
    this.options.onMessage(message, payload);
  }

  async #openLanes(run: Run, socket: string): Promise<void> {
    try {
      const [priority, egress] = await Promise.all(
        (["priority", "egress"] as const).map((lane) => this.#authenticate(run, lane, socket)),
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
        if (run === this.#run && !run.dead) this.options.onEgress(frame);
      });
      for (const lane of [priority.frames, egress.frames])
        lane.onEnd(() => {
          // During an idle shutdown ace-media closes its lanes itself; the grace timer still runs.
          if (!run.dead && !run.stopping) this.#kill(run, "lane-closed");
        });
      run.up = true;
      run.healthySince = this.options.clock.now();
      const listen = this.options.listen();
      run.normal.send(listen.message, listen.payload);
      this.options.replay();
      this.#ping(run);
    } catch (error) {
      if (run.dead) return;
      this.options.log("error", "ace-media lanes failed", { error: String(error) });
      this.#kill(run, "lane-closed");
    }
  }

  /** Connects one socket lane and authenticates it with the lane secret. */
  async #authenticate(
    run: Run,
    lane: SocketLane,
    path: string,
  ): Promise<{ socket: LaneSocket; frames: ByteSource } | undefined> {
    const socket = await this.options.host.connect(path);
    run.sockets.push(socket);
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
        this.options.log("error", "ace-media sent invalid framing", { error: String(error) });
        return this.#kill(run, "protocol");
      }
      for (const frame of frames) onFrame(frame);
    });
  }

  #stderr(run: Run, source: ByteSource): void {
    const decoder = new TextDecoder();
    let partial = "";
    source.onData((chunk) => {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) this.#stderrLine(run, line.slice(0, 4096));
    });
  }

  #stderrLine(run: Run, line: string): void {
    run.stderr.push(line);
    if (run.stderr.length > stderrKept) run.stderr.shift();
    const now = this.options.clock.now();
    const window = this.#logWindow;
    if (now - window.start >= 1_000) {
      if (window.suppressed > 0)
        this.options.log("warn", "ace-media stderr lines suppressed", { count: window.suppressed });
      this.#logWindow = { start: now, lines: 0, suppressed: 0 };
    }
    if (this.#logWindow.lines++ < stderrPerSecond)
      this.options.log("info", "ace-media stderr", { line });
    else this.#logWindow.suppressed++;
  }

  #ping(run: Run): void {
    this.#timer(run, supervisionTimings.pingMs, () => {
      if (run.pings >= supervisionTimings.missedPongs) return this.#kill(run, "missed-pongs");
      run.pings++;
      run.normal.send({ type: "ping", id: `ping-${++run.pingSeq}` });
      this.#ping(run);
    });
  }

  #scheduleIdle(): void {
    this.#idleTimer?.();
    this.#idleTimer = this.options.clock.setTimeout(() => {
      this.#idleTimer = undefined;
      const run = this.#run;
      if (this.#needs > 0 || !run || run.dead) return;
      if (!run.up || !run.priority) return this.#kill(run, "idle");
      run.stopping = true;
      run.cause = "idle";
      const graceMs = supervisionTimings.shutdownGraceMs;
      run.priority.send({ type: "shutdown", graceMs });
      this.#timer(run, graceMs, () => this.#kill(run, "idle"));
    }, supervisionTimings.idleMs);
  }

  #timer(run: Run, ms: number, callback: () => void): () => void {
    const cancel = this.options.clock.setTimeout(() => {
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
    const now = this.options.clock.now();
    const permanent = exit.code === 2 || exit.cause === "version-mismatch";
    const failure = exit.cause !== "idle" && exit.cause !== "disposed";
    if (
      run?.healthySince !== undefined &&
      now - run.healthySince >= supervisionTimings.healthyResetMs
    )
      this.#attempt = 0;
    this.#lastExit = {
      cause: exit.cause,
      code: exit.code,
      signal: exit.signal,
      stderr: run?.stderr ?? [],
    };
    let restartInMs: number | undefined;
    if (permanent) {
      this.#unavailable = {
        reason: exit.code === 2 ? "protocol or version mismatch (exit 2)" : "version mismatch",
      };
    } else if (failure) {
      this.#attempt++;
      const loop = crashLoop([...this.#failures, now], now);
      this.#failures = loop.recent;
      if (loop.looping) this.#markUnavailable(now);
      else if (this.#needs > 0 && !this.#disposed) {
        restartInMs = restartDelay(this.#attempt, this.options.random());
        this.#restartTimer = this.options.clock.setTimeout(() => {
          this.#restartTimer = undefined;
          if (this.#needs > 0 && !this.#disposed) this.#start();
        }, restartInMs);
      }
    } else if (this.#needs > 0 && !this.#disposed) this.#start();
    if (exit.cause !== "idle" && exit.cause !== "disposed")
      this.options.log(failure ? "warn" : "info", "ace-media exited", { ...exit, restartInMs });
    this.options.onExit?.({
      ...exit,
      failure,
      stills: [...(run?.stills ?? [])],
      connections: [...(run?.connections ?? [])],
      sources: [...(run?.sources ?? [])],
      recordings: [...(run?.recordings ?? [])],
      restartInMs,
    });
  }

  #markUnavailable(now: number): void {
    const until = now + supervisionTimings.unavailableMs;
    const cancel = this.options.clock.setTimeout(() => {
      this.#unavailable = undefined;
      this.#failures = [];
      this.#attempt = 0;
      if (this.#needs > 0 && !this.#disposed) this.#start();
    }, supervisionTimings.unavailableMs);
    this.#unavailable = { until, reason: "crash loop", cancel };
  }
}

function isRevocation(message: ToMedia): message is Revocation {
  return (
    message.type === "revoke" ||
    message.type === "connection.close" ||
    message.type === "relay.close"
  );
}

/** Which grants a revocation covers: the same owner issued no later, the connection, the stream. */
function revocationRule(revocation: Revocation): Rule {
  return (message) => {
    if (!grantTypes.has(message.type)) return false;
    if (revocation.type === "connection.close")
      return "connection" in message && message.connection === revocation.connection;
    if (revocation.type === "relay.close")
      return message.type === "relay.keys" && message.stream === revocation.stream;
    if (!("owner" in message) || !("issued" in message)) return false;
    const { owner } = message;
    return (
      owner.device === revocation.device &&
      message.issued <= revocation.issued &&
      (!revocation.admission || sameAdmission(owner.admission, revocation.admission))
    );
  };
}

function sameAdmission(
  a: Message<"media.ticket">["owner"]["admission"],
  b: Message<"media.ticket">["owner"]["admission"],
): boolean {
  if (a.kind === "pairing" && b.kind === "pairing") return a.generation === b.generation;
  if (a.kind === "account" && b.kind === "account") return a.account === b.account;
  return false;
}

/** The in-flight work a run holds, so its exit can fail exactly that. */
function track(run: Run, message: ToMedia): void {
  switch (message.type) {
    case "source.open":
      return void run.sources.add(message.source);
    case "source.close":
      return void run.sources.delete(message.source);
    case "record.start":
      return void run.recordings.add(message.recording);
    case "record.stop":
      return void run.recordings.delete(message.recording);
    case "still.take":
      return void run.stills.add(message.request);
    case "media.ticket":
      return void run.connections.add(message.connection);
  }
}

function settle(run: Run, message: FromMedia): void {
  switch (message.type) {
    case "still.done":
    case "still.failed":
      return void run.stills.delete(message.request);
    case "record.done":
    case "record.failed":
      return void run.recordings.delete(message.recording);
    case "connection.open":
      return void run.connections.add(message.connection);
    case "connection.closed":
      return void run.connections.delete(message.connection);
  }
}

/** The real host: ace-media as an owned child process, its lanes over `node:net`. */
export function nodeMediaHost(
  env: NodeJS.ProcessEnv,
  launch: (binary: string) => { command: string; args: string[] } = (binary) => ({
    command: binary,
    args: [],
  }),
): MediaHost {
  return {
    spawn(binary) {
      const { command, args } = launch(binary);
      const child = spawnRawSupervised({ command, args, env, name: "ace-media" });
      return {
        pid: child.pid,
        stdin: nodeByteSink(child.stdin),
        stdout: nodeByteSource(child.stdout),
        stderr: nodeByteSource(child.stderr),
        exited: child.exited.then(({ code, signal }) => ({ code, signal })),
        kill: () => void child.stop({ graceMs: 0 }),
      };
    },
    connect: connectLane,
  };
}

/** The wall clock and timers, for the daemon. */
export const systemMediaClock: MediaClock = {
  now: () => performance.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
