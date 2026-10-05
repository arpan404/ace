interface Isolate {
  threadId: number;
  workerIds: readonly number[];
}

/** Telemetry files outlive isolates; only the observed worker tree proves liveness. */
export function liveWorkerTelemetry<T extends Isolate>(
  samples: readonly T[],
): { main: T; workers: T[] } {
  const byId = new Map(samples.map((entry) => [entry.threadId, entry]));
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
