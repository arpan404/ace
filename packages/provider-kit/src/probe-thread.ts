// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { Worker } from "node:worker_threads";
import { IdleWorker, type IdleWorkerRuntime } from "./idle-worker.ts";
import { OutputLimitError } from "./output-budget.ts";
import { ProbeReply, type ProbeRequest } from "./probe-messages.ts";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";

export type ProbeExit = Omit<Extract<ProbeReply, { type: "exit" }>, "type" | "id">;
export interface ProbeThread {
  run(request: Omit<ProbeRequest, "type" | "id">, signal: AbortSignal): Promise<ProbeExit>;
}

const runtime: IdleWorkerRuntime = {
  spawn(entry, options) {
    const worker = new Worker(entry, options);
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

/**
 * Bounded CLI probes spawned on a worker thread. The main thread records each process group the
 * moment the worker reports its pid, so shutdown and crash recovery still own it.
 */
export function createProbeThread(
  entry = new URL("./probe-worker.ts", import.meta.url),
  workers: IdleWorkerRuntime = runtime,
): ProbeThread {
  const worker = new IdleWorker(entry, { execArgv: [] }, workers);
  let next = 0;
  const flights = new Map<
    number,
    { pid?: number; resolve(exit: ProbeExit): void; reject(error: Error): void }
  >();
  const fail = (error: Error) => {
    for (const flight of flights.values()) {
      if (flight.pid !== undefined) {
        stopGroup(flight.pid);
        unregisterGroup(flight.pid);
      }
      flight.reject(error);
    }
    flights.clear();
  };
  worker.on("message", (input: unknown) => {
    const message = ProbeReply.safeParse(input);
    if (!message.success) return;
    const flight = flights.get(message.data.id);
    if (!flight) return;
    if (message.data.type === "spawned") {
      const { pid, id } = message.data;
      flight.pid = pid;
      try {
        registerGroup(
          pid,
          () => {
            worker.postMessage({ type: "stop", id });
            return Promise.resolve();
          },
          { name: "cli-probe" },
        );
      } catch {
        // Unrecorded, it must not outlive this probe.
        stopGroup(pid);
      }
      return;
    }
    const { type: _type, id, ...exit } = message.data;
    flights.delete(id);
    if (flight.pid !== undefined) unregisterGroup(flight.pid);
    flight.resolve(exit);
    if (!flights.size) worker.idle();
  });
  worker.on("error", (error: Error) => fail(error));
  worker.on("exit", () => fail(new Error("Probe worker stopped")));
  return {
    run(request, signal) {
      const id = next++;
      const done = Promise.withResolvers<ProbeExit>();
      const flight: { pid?: number; resolve(exit: ProbeExit): void; reject(error: Error): void } = {
        resolve: done.resolve,
        reject: done.reject,
      };
      flights.set(id, flight);
      const abort = () => {
        if (flight.pid !== undefined) stopGroup(flight.pid);
        worker.postMessage({ type: "stop", id });
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        worker.postMessage({ type: "run", id, ...request });
        if (signal.aborted) abort();
      } catch (error) {
        flights.delete(id);
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
