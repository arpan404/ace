import { z } from "zod";

interface Isolate {
  threadId: number;
  workerIds: readonly number[];
}
interface Lifecycle extends Isolate {
  generation: number;
  pendingWorkerIds: readonly number[];
}

/** Telemetry files outlive isolates; only the observed worker tree proves liveness. */
export function liveWorkerTelemetry<T extends Isolate>(
  samples: readonly T[],
): { main: T; workers: T[] } {
  const byId = new Map(samples.map((entry) => [entry.threadId, entry]));
  if (byId.size !== samples.length) throw new Error("Invalid worker telemetry: duplicate isolate");
  const main = byId.get(0);
  if (!main) throw new Error("Missing main telemetry");
  const live = [main];
  const seen = new Set([0]);
  for (const parent of live) {
    for (const id of parent.workerIds) {
      if (seen.has(id)) throw new Error(`Invalid worker telemetry tree: ${id}`);
      const worker = byId.get(id);
      if (!worker) throw new Error(`Missing live worker telemetry: ${id}`);
      seen.add(id);
      live.push(worker);
    }
  }
  return { main, workers: live.slice(1) };
}

/** Read only the acknowledged live tree, then verify its lifecycle generations.
 * A disappearing file is a transition only if ownership changed; stable missing
 * telemetry remains an error. Initialization waits count against the caller's deadline.
 */
export async function readWorkerSnapshot<T extends Lifecycle>(io: {
  read(id: number): Promise<T>;
  now(): number;
  pause(): Promise<void>;
  timeoutMs: number;
}): Promise<{ main: T; workers: T[] }> {
  const started = io.now();
  for (;;) {
    const samples: T[] = [];
    const ids = [0];
    const seen = new Set<number>();
    let missing: unknown;
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`Invalid worker telemetry tree: ${id}`);
      seen.add(id);
      let sample: T;
      try {
        sample = await io.read(id);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        missing = error;
        break;
      }
      if (sample.threadId !== id) throw new Error(`Invalid worker telemetry identity: ${id}`);
      samples.push(sample);
      ids.push(...sample.workerIds);
    }
    let changed = false;
    for (const sample of samples) {
      try {
        if ((await io.read(sample.threadId)).generation !== sample.generation) changed = true;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        changed = true;
      }
    }
    const pending = samples.some((sample) => sample.pendingWorkerIds.length > 0);
    if (!changed && !pending) {
      if (missing) throw missing;
      return liveWorkerTelemetry(samples);
    }
    if (io.now() - started >= io.timeoutMs) throw new Error("Worker telemetry did not stabilize");
    await io.pause();
  }
}

function isMissingFile(error: unknown): boolean {
  return z.object({ code: z.literal("ENOENT") }).safeParse(error).success;
}
