import type { ThreadState } from "./state.ts";
import { silenceDeadlineReader, isSettled } from "./status.ts";
import { transportSignalAt } from "./liveness.ts";

/** Earliest injected instant at which a tick can change an agent status.
 * A wake expiry always leaves non-active `working`. Descendant transitions are
 * scheduled first, then the next pass observes whether ancestors can fall silent.
 * This keeps one current-relevance summary, rather than a tree cache per time.
 */
export function nextDeadline(state: ThreadState, providerDeadline?: number): number | undefined {
  if (state.processExit) return undefined;
  let next =
    providerDeadline !== undefined &&
    Number.isSafeInteger(providerDeadline) &&
    providerDeadline >= 0
      ? providerDeadline
      : undefined;
  const silenceDeadline =
    state.config.liveness === "transport" ? undefined : silenceDeadlineReader(state);
  const transportDeadline = Math.floor(transportSignalAt(state) + state.config.silenceMs) + 1;
  function admit(candidate: number | undefined): void {
    if (candidate === undefined || !Number.isSafeInteger(candidate)) return;
    next = next === undefined ? candidate : Math.min(next, candidate);
  }
  for (const [key, record] of Object.entries(state.agents)) {
    if (record.limited) continue;
    if (
      state.config.liveness !== "transport" &&
      key === state.rootKey &&
      !state.hasRun &&
      record.agent.fidelity !== "placeholder" &&
      !record.activeRun &&
      record.wakeUntil === undefined
    )
      continue;
    if (
      !record.activeRun &&
      record.wakeUntil !== undefined &&
      record.agent.status.state === "working"
    )
      admit(record.wakeUntil);
    if (state.config.liveness === "transport") {
      if (!isSettled(record.agent.status) && record.agent.status.state !== "unresponsive")
        admit(transportDeadline);
    } else if (
      record.agent.status.state !== "unresponsive" &&
      (record.activeRun || !record.lastRun)
    ) {
      admit(silenceDeadline?.(key, record));
    }
  }
  return next;
}
