import type { ThreadState } from "./state.ts";
import { statusReader, isSettled } from "./status.ts";
import { subtreeSignalReader, transportSignalAt } from "./liveness.ts";

/** Earliest injected instant at which a tick can change an agent status. */
export function nextDeadline(state: ThreadState): number | undefined {
  if (state.processExit) return undefined;
  let next: number | undefined;
  const subtreeSignal = subtreeSignalReader(state);
  const readStatus = statusReader(state);
  const readers = new Map<number, ReturnType<typeof readStatus>>();
  const latestTransportSignal = transportSignalAt(state);
  for (const [key, record] of Object.entries(state.agents)) {
    if (
      state.config.liveness !== "transport" &&
      key === state.rootKey &&
      !state.hasRun &&
      record.agent.fidelity !== "placeholder" &&
      !record.activeRun &&
      record.wakeUntil === undefined
    )
      continue;
    const candidates: number[] = [];
    if (
      !record.activeRun &&
      record.wakeUntil !== undefined &&
      record.agent.status.state === "working"
    )
      candidates.push(record.wakeUntil);
    if (state.config.liveness === "transport") {
      if (!isSettled(record.agent.status) && record.agent.status.state !== "unresponsive") {
        candidates.push(Math.floor(latestTransportSignal + state.config.silenceMs) + 1);
      }
    } else if (
      record.agent.status.state !== "unresponsive" &&
      (record.activeRun || !record.lastRun)
    ) {
      candidates.push(Math.floor(subtreeSignal(key) + state.config.silenceMs) + 1);
    }
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate)) continue;
      let resolve = readers.get(candidate);
      if (!resolve) {
        resolve = readStatus(candidate);
        readers.set(candidate, resolve);
      }
      if (JSON.stringify(resolve(key)) === JSON.stringify(record.agent.status)) continue;
      next = next === undefined ? candidate : Math.min(next, candidate);
    }
  }
  return next;
}
