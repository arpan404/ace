// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { startWorker } from "./worker.ts";
import { IdleWorker, type IdleWorkerRuntime } from "./idle-worker.ts";
import { OutputLimitError } from "./output-budget.ts";
import { ProbeReply, type ProbeRequest } from "./probe-messages.ts";
import { z } from "zod";
import { admitProcess, killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";

export type ProbeExit = Omit<Extract<ProbeReply, { type: "exit" }>, "type" | "id">;
export interface ProbeThread {
  run(request: Omit<ProbeRequest, "type" | "id">, signal: AbortSignal): Promise<ProbeExit>;
}

const runtime: IdleWorkerRuntime = {
  spawn(entry, options) {
    const worker = startWorker(entry, options);
    // An idle isolate never keeps a CLI command or a stopping daemon alive.
    worker.unref();
    return worker;
  },
  delay(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
  now: () => performance.now(),
};

function stopGroup(pid: number): void {
  try {
    killGroup(pid, "SIGKILL");
  } catch {
    // A group this daemon can no longer signal is not one it can stop.
  }
}

const ProbeAddress = z.object({
  id: z.number().int().nonnegative(),
  type: z.unknown().optional(),
});

type Flight = {
  id: number;
  pid?: number;
  stopping: boolean;
  /** Set when the worker sent a reply this thread can't read; the probe fails with it. */
  failure?: Error;
  done: PromiseWithResolvers<ProbeExit>;
  /** Settles once the worker confirms the process ended, or the worker itself is gone. */
  settled: Promise<void>;
  release(): void;
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
    flight.stopping = true;
    if (flight.pid !== undefined) stopGroup(flight.pid);
    try {
      worker.postMessage({ type: "stop", id: flight.id });
    } catch {
      // A closed worker has already failed every flight.
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
      if (flight.pid !== undefined) stopGroup(flight.pid);
      end(flight);
      flight.done.reject(error);
    }
  };
  worker.on("message", (input: unknown) => {
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
      void stop(flight);
      return;
    }
    const flight = flights.get(message.data.id);
    if (!flight) return;
    if (message.data.type === "spawned") {
      const { pid } = message.data;
      flight.pid = pid;
      try {
        registerGroup(pid, () => stop(flight), { name: "cli-probe" });
      } catch {
        // Unrecorded, it must not outlive this probe.
        flight.stopping = true;
      }
      // Owned by pid now; the admission that covered the gap is no longer needed.
      flight.release();
      if (flight.stopping) stopGroup(pid);
      return;
    }
    const { type: _type, id: _id, ...exit } = message.data;
    end(flight);
    if (flight.failure) flight.done.reject(flight.failure);
    else flight.done.resolve(exit);
    if (!flights.size) worker.idle();
  });
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
    maxBytes: number;
    signal?: AbortSignal | undefined;
    schedule: (callback: () => void, milliseconds: number) => () => void;
    thread?: ProbeThread | undefined;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const thread = options.thread ?? (shared ??= createProbeThread());
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.env }))
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
    const exit = await thread.run(
      { command, args: [...args], env, maxBytes: options.maxBytes },
      stop.signal,
    );
    if (failure) throw failure;
    if (exit.reason === "output-limit") throw new OutputLimitError("Probe output exceeded limit");
    if (exit.reason === "spawn-error") throw new Error("Probe failed to start");
    return { stdout: exit.stdout.trim(), stderr: exit.stderr.trim(), code: exit.code };
  } finally {
    cancel();
    options.signal?.removeEventListener("abort", abort);
  }
}
