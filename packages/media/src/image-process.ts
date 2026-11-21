import { watchMemory } from "@ace/provider-kit/memory-watchdog";
import type { ResidentSampler } from "@ace/provider-kit/resident-memory";
import type { MediaLog } from "./diagnostics.ts";
import { MediaImages, type ImageJob, type ImageResult, type ImageWork } from "./images.ts";
import { controlFrameReader, LaneWriter } from "./lanes.ts";
import { crashLoop, restartDelay, supervisionTimings } from "./supervision-policy.ts";
import type { MediaChild, MediaClock } from "./supervisor-host.ts";
import { decodeFromMedia, type ToMedia } from "./wire.ts";

/*
 * The image process (ADR 0201 §3, §6): `ace-media --images --root <dir>`, supervised here on
 * its own, apart from the media process that carries live video and recordings, so no picture
 * can take those down. It starts on the first image job on every OS, stops when idle, restarts
 * with backoff after a crash, is marked unavailable after a crash loop, and is killed when it
 * holds more memory than its limit. Its stdin and stdout are its only lane.
 */

export type ImageProcessOptions = {
  binary: string;
  /** The one directory file inputs may come from: the daemon's data directory. */
  root: string;
  /** Starts the binary with these arguments, owned like every child the daemon runs. */
  spawn: (binary: string, args: readonly string[]) => MediaChild;
  clock: MediaClock;
  /** A request id unique for this daemon's lifetime. */
  nextId: () => string;
  /** Backoff jitter only. */
  random: () => number;
  log: MediaLog;
  /** The resident-memory watchdog: past `limitBytes` the process is killed and restarted. */
  memory?: { sample: ResidentSampler; limitBytes: number; intervalMs: number } | undefined;
  /** How long after its last job the process is stopped. */
  idleMs?: number;
};

type Run = {
  child: MediaChild;
  writer: LaneWriter;
  stopWatching?: (() => void) | undefined;
  /** Stopped on purpose (idle, dispose): not a failure. */
  stopping: boolean;
  stderr: string;
  startedAt: number;
};

export class ImageProcess implements ImageWork {
  readonly #options: ImageProcessOptions;
  readonly #images: MediaImages;
  #run: Run | undefined;
  #needs = 0;
  #idleTimer: (() => void) | undefined;
  #restartTimer: (() => void) | undefined;
  #failures: number[] = [];
  #attempt = 0;
  #unavailable: { reason: string; cancel: () => void } | undefined;
  #disposed = false;

  constructor(options: ImageProcessOptions) {
    this.#options = options;
    this.#images = new MediaImages({
      send: (message, payload) => this.#send(message, payload),
      require: () => this.#require(),
      phase: () =>
        this.#unavailable
          ? { phase: "unavailable", reason: this.#unavailable.reason }
          : { phase: this.#run ? "running" : this.#restartTimer ? "backoff" : "idle" },
      clock: options.clock,
      nextId: options.nextId,
    });
  }

  run(job: ImageJob): Promise<ImageResult> {
    if (this.#disposed) return this.#images.run({ ...job, signal: AbortSignal.abort() });
    return this.#images.run(job);
  }

  /** Jobs not yet settled. */
  get pending(): number {
    return this.#images.pending;
  }

  /** The running process's id. */
  pid(): number | undefined {
    return this.#run?.child.pid;
  }

  dispose(): void {
    this.#disposed = true;
    this.#idleTimer?.();
    this.#restartTimer?.();
    this.#unavailable?.cancel();
    this.#stop();
  }

  #send(message: ToMedia, payload: Uint8Array): boolean {
    const run = this.#run;
    if (!run || run.stopping) return false;
    run.writer.send(message, payload);
    return true;
  }

  #require(): () => void {
    this.#needs++;
    this.#idleTimer?.();
    this.#idleTimer = undefined;
    if (!this.#run && !this.#restartTimer && !this.#unavailable && !this.#disposed) this.#start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#needs--;
      if (this.#needs === 0)
        this.#idleTimer = this.#options.clock.setTimeout(() => {
          this.#idleTimer = undefined;
          if (this.#needs === 0) this.#stop();
        }, this.#options.idleMs ?? supervisionTimings.idleMs);
    };
  }

  #start(): void {
    const { binary, root, spawn, log, memory } = this.#options;
    let child: MediaChild;
    try {
      child = spawn(binary, ["--images", "--root", root]);
    } catch (error) {
      log("error", "ace-media's image process failed to start", { error: String(error) });
      this.#failed(`it could not start: ${String(error)}`);
      return;
    }
    const run: Run = {
      child,
      stopping: false,
      stderr: "",
      startedAt: this.#options.clock.now(),
      writer: new LaneWriter("normal", child.stdin, () => child.kill()),
    };
    this.#run = run;
    const frames = controlFrameReader("normal");
    child.stdout.onData((chunk) => {
      try {
        for (const frame of frames.push(chunk)) {
          const { message, payload } = decodeFromMedia(frame, "normal");
          this.#images.message(message, payload);
        }
      } catch (error) {
        log("error", "ace-media's image process sent an invalid frame", { error: String(error) });
        child.kill();
      }
    });
    child.stderr.onData((chunk) => {
      // The last lines say why it stopped, when it does.
      run.stderr = (run.stderr + new TextDecoder().decode(chunk)).slice(-2048);
    });
    if (memory && child.pid !== undefined)
      run.stopWatching = watchMemory({
        pid: child.pid,
        limitBytes: memory.limitBytes,
        intervalMs: memory.intervalMs,
        sample: memory.sample,
        schedule: (callback, ms) => this.#options.clock.setTimeout(callback, ms),
        onExceeded: (bytes) => {
          log("warn", "ace-media's image process went over its memory limit", { bytes });
          child.kill();
        },
        onSampleError: (error) =>
          log("warn", "ace-media's image process memory limit is not enforced", {
            error: String(error),
          }),
      });
    void child.exited.then((exit) => this.#exited(run, exit));
    // Its stdin takes frames from the start: whatever waited goes now.
    this.#images.ready();
  }

  #stop(): void {
    const run = this.#run;
    if (!run) return;
    run.stopping = true;
    run.child.kill();
  }

  #exited(run: Run, exit: { code: number | null; signal: string | null }): void {
    if (this.#run !== run) return;
    this.#run = undefined;
    run.stopWatching?.();
    run.writer.close();
    if (run.stopping) {
      this.#images.exited();
      return;
    }
    // A process that ran well before failing starts its backoff over.
    if (this.#options.clock.now() - run.startedAt >= supervisionTimings.healthyResetMs)
      this.#attempt = 0;
    const stderr = run.stderr.trim().split("\n").at(-1) ?? "";
    const reason = `exited ${exit.code ?? exit.signal ?? "?"}${stderr ? `: ${stderr}` : ""}`;
    this.#options.log("warn", "ace-media's image process exited", { reason });
    this.#failed(reason);
    this.#images.exited();
  }

  #failed(reason: string): void {
    const now = this.#options.clock.now();
    const loop = crashLoop([...this.#failures, now], now);
    this.#failures = loop.recent;
    this.#attempt++;
    if (loop.looping || this.#disposed) {
      if (this.#disposed) return;
      const cancel = this.#options.clock.setTimeout(() => {
        this.#unavailable = undefined;
        this.#failures = [];
        this.#attempt = 0;
      }, supervisionTimings.unavailableMs);
      this.#unavailable = { reason: `its image process keeps failing (${reason})`, cancel };
      return;
    }
    if (this.#needs === 0) return;
    this.#restartTimer = this.#options.clock.setTimeout(
      () => {
        this.#restartTimer = undefined;
        if (this.#needs > 0 && !this.#disposed) this.#start();
      },
      restartDelay(this.#attempt, this.#options.random()),
    );
  }
}
