// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { startWorker } from "./worker.ts";
import { IdleWorker, type IdleWorkerRuntime } from "./idle-worker.ts";
import { OutputLimitError } from "./output-budget.ts";
import { ProbeReply, type ProbeRequest } from "./probe-messages.ts";
import { z } from "zod";
import { admitProcess, killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";
import { reportedGroup, signalSoon, type LeaderGroup } from "./leader-group.ts";
import { supervisorBackend } from "./native-switches.ts";
import { requestOwner, unscoped, type RequestOwner } from "./unscoped.ts";
import { markedEnv } from "./process-marker.ts";

export type ProbeExit = Omit<Extract<ProbeReply, { type: "exit" }>, "type" | "id">;
export interface ProbeThread {
  run(request: Omit<ProbeRequest, "type" | "id">, signal: AbortSignal): Promise<ProbeExit>;
}

const runtime: IdleWorkerRuntime = {
  spawn: (entry, options) => startWorker(entry, options),
  // An idle isolate never keeps a CLI command or a stopping daemon alive. A probe in flight
  // still does: its child process is ref'd.
  background: true,
  delay(callback, milliseconds) {
    // The idle timer is the thread's own, never the caller's that last used it.
    const timer = unscoped(() => setTimeout(callback, milliseconds));
    timer.unref();
    return () => clearTimeout(timer);
  },
  now: () => performance.now(),
};

/**
 * The worker may already have reaped the probe when this thread acts, so the TypeScript backend's
 * group is signalled through the identity the worker read at spawn; without one, only the worker
 * stops it. Under the native supervisor a signal goes only through a handle that holds the probe:
 * by identity when one was read, never by pid alone on POSIX, where only the worker stops it, and
 * on Windows the tree stop is taskkill's.
 */
function stopGroup(pid: number, group: LeaderGroup | undefined, start?: string): void {
  try {
    if (supervisorBackend() === "native") killGroup(pid, "SIGKILL", undefined, start);
    else if (group) signalSoon(group, "SIGKILL");
  } catch {
    // A group this daemon can no longer signal is not one it can stop.
  }
}

/** How long a stopped probe waits for its worker to confirm the exit before the worker is ended. */
export const stopGraceMs = 2_000;

const ProbeAddress = z.object({
  id: z.number().int().nonnegative(),
  type: z.unknown().optional(),
});

type Flight = {
  id: number;
  pid?: number;
  group?: LeaderGroup;
  /** The spawn's kernel start: the identity the native supervisor's handle is taken by. */
  start?: string | undefined;
  stopping: boolean;
  /** Set when the worker sent a reply this thread can't read; the probe fails with it. */
  failure?: Error;
  done: PromiseWithResolvers<ProbeExit>;
  /** Settles once the worker confirms the process ended, or the worker itself is gone. */
  settled: Promise<void>;
  release(): void;
  /** The context of the caller that asked: this probe's replies are handled in it. */
  owner: RequestOwner;
};

/**
 * Bounded CLI probes spawned on a worker thread. Each one is owned from the moment it is
 * requested: before its pid arrives a global stop waits for it, and once the worker reports the
 * pid the main thread records the process and can kill it directly.
 */
export function createProbeThread(
  entry = new URL("./probe-worker.ts", import.meta.url),
  workers: IdleWorkerRuntime = runtime,
): ProbeThread {
  const worker = new IdleWorker(entry, { execArgv: [] }, workers);
  let next = 0;
  const flights = new Map<number, Flight>();
  const stop = (flight: Flight) => {
    const first = !flight.stopping;
    flight.stopping = true;
    if (flight.pid !== undefined) stopGroup(flight.pid, flight.group, flight.start);
    try {
      worker.postMessage({ type: "stop", id: flight.id });
    } catch {
      // A closed worker has already failed every flight.
    }
    // A worker stuck in a spawn reads no stop and sends no exit: past a short grace it is ended
    // itself, which fails its flights, so neither the probe nor a global stop waits on it.
    if (first) {
      const cancel = workers.delay(() => {
        if (flights.get(flight.id) === flight) worker.recycle();
      }, stopGraceMs);
      void flight.settled.then(cancel);
    }
    return flight.settled;
  };
  const end = (flight: Flight) => {
    flights.delete(flight.id);
    flight.release();
    if (flight.pid !== undefined) unregisterGroup(flight.pid);
  };
  const fail = (error: Error) => {
    for (const flight of flights.values()) {
      if (flight.pid !== undefined) stopGroup(flight.pid, flight.group, flight.start);
      end(flight);
      flight.done.reject(error);
    }
    // No work is left for the process to stay alive for.
    worker.idle();
  };
  // One thread serves every caller. Each reply is handled in the context of the caller whose
  // probe it answers, never the context of whoever first started the thread.
  worker.on("message", (input: unknown) => {
    const addressed = ProbeAddress.safeParse(input);
    const flight = addressed.success ? flights.get(addressed.data.id) : undefined;
    if (flight) flight.owner(() => reply(input));
  });
  const reply = (input: unknown) => {
    const message = ProbeReply.safeParse(input);
    if (!message.success) {
      const addressed = ProbeAddress.safeParse(input);
      const flight = addressed.success ? flights.get(addressed.data.id) : undefined;
      if (!flight) return;
      // A probe waiting on a reply it can't read would wait forever; it fails instead.
      flight.failure ??= new Error("Probe worker sent an invalid reply");
      if (addressed.data?.type === "exit") {
        // The worker has seen this process close and will send nothing more. Its group may be
        // reaped and its pid reused, so it is not signalled.
        end(flight);
        flight.done.reject(flight.failure);
        if (!flights.size) worker.idle();
        return;
      }
      // Still running, perhaps unrecorded: stop it and stay its owner until the worker confirms
      // the exit (or dies), so a global stop keeps waiting for it.
      // settled absorbs the probe's failure; the caller still sees it through done.
      void stop(flight).catch(() => {});
      return;
    }
    const flight = flights.get(message.data.id);
    if (!flight) return;
    if (message.data.type === "spawned") {
      const { pid, unique, start } = message.data;
      flight.pid = pid;
      // Kept on the flight: a dead worker's probe is still stopped through this identity.
      flight.start = start;
      const group =
        start === undefined || supervisorBackend() === "native"
          ? undefined
          : reportedGroup({ pid, start, unique });
      if (group) flight.group = group;
      try {
        registerGroup(
          pid,
          () => stop(flight),
          { name: "cli-probe", ...(unique ? { unique } : {}) },
          () => stopGroup(pid, group, start),
        );
      } catch {
        // Unrecorded, it must not outlive this probe.
        flight.stopping = true;
      }
      // Owned by pid now; the admission that covered the gap is no longer needed.
      flight.release();
      if (flight.stopping) stopGroup(pid, group, start);
      return;
    }
    const { type: _type, id: _id, ...exit } = message.data;
    end(flight);
    if (flight.failure) flight.done.reject(flight.failure);
    else flight.done.resolve(exit);
    if (!flights.size) worker.idle();
  };
  worker.on("error", (error: Error) => fail(error));
  worker.on("exit", () => fail(new Error("Probe worker stopped")));
  return {
    run(request, signal) {
      const id = next++;
      const done = Promise.withResolvers<ProbeExit>();
      const flight: Flight = {
        id,
        stopping: false,
        done,
        settled: done.promise.then(
          () => {},
          () => {},
        ),
        release: () => {},
        owner: requestOwner(),
      };
      flight.release = admitProcess(
        () => stop(flight),
        () => {},
      );
      flights.set(id, flight);
      const abort = () => void stop(flight);
      signal.addEventListener("abort", abort, { once: true });
      try {
        worker.postMessage({ type: "run", id, ...request });
        if (signal.aborted) abort();
      } catch (error) {
        end(flight);
        done.reject(error instanceof Error ? error : new Error("Probe worker unavailable"));
        if (!flights.size) worker.idle();
      }
      return done.promise.finally(() => signal.removeEventListener("abort", abort));
    },
  };
}

let shared: ProbeThread | undefined;

/** Bounded, read-only CLI probe run from the probe worker. Raw output is returned only to the caller. */
export async function probeOffThread(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    cwd?: string | undefined;
    maxBytes: number;
    signal?: AbortSignal | undefined;
    schedule: (callback: () => void, milliseconds: number) => () => void;
    thread?: ProbeThread | undefined;
    /** A global stop: ends the process, and its exit is still the probe's answer. */
    halt?: AbortSignal | undefined;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // Shared by every caller, so started in no caller's context.
  const thread = options.thread ?? (shared ??= unscoped(() => createProbeThread()));
  const env: Record<string, string> = {};
  // Marked here, on the owner's thread: the probe worker owns no run of its own.
  for (const [key, value] of Object.entries(markedEnv({ ...process.env, ...options.env })))
    if (value !== undefined) env[key] = value;
  const stop = new AbortController();
  let failure: Error | undefined;
  const abort = () => {
    failure ??= new Error("Probe aborted");
    stop.abort();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const cancel = options.schedule(() => {
    failure ??= new Error("Probe timed out");
    stop.abort();
  }, options.timeoutMs);
  try {
    const exit = await thread
      .run(
        {
          command,
          args: [...args],
          env,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          maxBytes: options.maxBytes,
        },
        options.halt ? AbortSignal.any([stop.signal, options.halt]) : stop.signal,
      )
      // A probe stopped for its deadline or an abort says so, even when its worker had to be
      // ended to stop it.
      .catch((error: unknown) => {
        throw failure ?? error;
      });
    if (failure) throw failure;
    if (exit.reason === "output-limit") throw new OutputLimitError("Probe output exceeded limit");
    if (exit.reason === "spawn-error") throw new Error("Probe failed to start");
    return { stdout: exit.stdout.trim(), stderr: exit.stderr.trim(), code: exit.code };
  } finally {
    cancel();
    options.signal?.removeEventListener("abort", abort);
  }
}
