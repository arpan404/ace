import type { ThreadReader } from "@ace/client";
import { useIntent, useThread } from "@ace/client-react";
import { useSyncExternalStore } from "react";

/*
 * Stop, from the click until the turn ends (UX audit SY-8): the composer's button and the
 * turn's live line both say "Stopping…" while the durable `thread.interrupt` is on its way and
 * the turn it named is still running. The interrupt carries that turn's run, so a Stop sent
 * offline can't end a later turn started meanwhile (the daemon answers `stale_interrupt`).
 */

interface StopRecord {
  commandId: string;
  /** The root turn the Stop was pressed in, when its run was known. */
  runId: string | undefined;
}

type Listener = () => void;
let stops: ReadonlyMap<string, StopRecord> = new Map();
const listeners = new Set<Listener>();
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => stops;
function publish(next: ReadonlyMap<string, StopRecord>) {
  stops = next;
  for (const listener of listeners) listener();
}

export function recordStop(threadId: string, record: StopRecord): void {
  publish(new Map(stops).set(threadId, record));
}

/** The turn is over (or a new one began): this thread has no Stop on its way any more. */
export function clearStop(threadId: string): void {
  if (!stops.has(threadId)) return;
  const next = new Map(stops);
  next.delete(threadId);
  publish(next);
}

/** The root agent's turn in flight: the newest item's run, while that run is active. */
export function activeRootRun(reader: ThreadReader): string | undefined {
  const root = reader.thread?.rootAgentId;
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const runId = reader.item(reader.order[index] ?? "")?.runId;
    if (!runId) continue;
    const run = reader.run(runId);
    if (run?.agentId !== root) continue;
    return run?.state === "active" ? runId : undefined;
  }
  return undefined;
}

const runKeys = ["order", "thread"] as const;

/** The active root run's id, for a Stop to name. */
export function useActiveRootRun(threadId: string | undefined): string | undefined {
  return useThread(threadId, runKeys, activeRootRun);
}

/**
 * A Stop is on its way in this thread: it was pressed in the turn still running and the daemon
 * hasn't refused it. Once the turn ends the composer clears the record.
 */
export function useStopping(threadId: string | undefined): boolean {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const record = threadId === undefined ? undefined : all.get(threadId);
  const intent = useIntent(record?.commandId);
  // Only a thread with a Stop on its way watches which turn is running.
  const run = useActiveRootRun(record ? threadId : undefined);
  const sameTurn = record?.runId === undefined || run === undefined || run === record.runId;
  return !!record && intent?.state !== "failed" && intent?.state !== "acked" && sameTurn;
}

/** Test seam. */
export function resetStops(): void {
  publish(new Map());
}
