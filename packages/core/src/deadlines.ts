import type { ThreadState } from "./state.ts";
import { silenceDeadlineReader, isSettled } from "./status.ts";
import { transportSignalAt } from "./liveness.ts";

/** Earliest injected instant at which a tick can change an agent status.
 * A wake expiry always leaves non-active `working`. Descendant transitions are
 * scheduled first, then the next pass observes whether ancestors can fall silent.
 * This keeps one current-relevance summary, rather than a tree cache per time.
 */
function candidates(
  state: ThreadState,
): { key: string; at: number; kind: "silence" | "wake" | "transport" }[] {
  if (state.processExit) return [];
  const result: { key: string; at: number; kind: "silence" | "wake" | "transport" }[] = [];
  const silenceDeadline =
    state.config.liveness === "transport" ? undefined : silenceDeadlineReader(state);
  const transportDeadline = Math.floor(transportSignalAt(state) + state.config.silenceMs) + 1;
  function admit(
    key: string,
    kind: "silence" | "wake" | "transport",
    candidate: number | undefined,
  ): void {
    if (candidate !== undefined && Number.isSafeInteger(candidate))
      result.push({ key, at: candidate, kind });
  }
  for (const [key, record] of Object.entries(state.agents)) {
    if (record.externalStatus || record.limited) continue;
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
      admit(key, "wake", record.wakeUntil);
    if (state.config.liveness === "transport") {
      if (!isSettled(record.agent.status) && record.agent.status.state !== "unresponsive")
        admit(key, "transport", transportDeadline);
    } else if (
      record.agent.status.state !== "unresponsive" &&
      (record.activeRun || !record.lastRun)
    ) {
      admit(key, "silence", silenceDeadline?.(key, record));
    }
  }
  return result;
}

function earliest(values: Iterable<number>, providerDeadline?: number): number | undefined {
  let next =
    providerDeadline !== undefined &&
    Number.isSafeInteger(providerDeadline) &&
    providerDeadline >= 0
      ? providerDeadline
      : undefined;
  for (const at of values) next = next === undefined ? at : Math.min(at, next);
  return next;
}
export function nextDeadline(state: ThreadState, providerDeadline?: number): number | undefined {
  if (state.processExit) return undefined;
  return earliest(
    candidates(state).map((candidate) => candidate.at),
    providerDeadline,
  );
}

/** Candidate eligibility changes at structural facts. Ordinary deltas only move ancestor silence. */
export class DeadlineIndex {
  private entries: ReturnType<typeof candidates> = [];
  private parents = new Map<string, string | undefined>();
  private exited = false;
  constructor(state: ThreadState) {
    this.rebuild(state);
  }
  rebuild(state: ThreadState): void {
    this.exited = state.processExit !== undefined;
    this.entries = candidates(state);
    this.parents.clear();
    for (const [key, record] of Object.entries(state.agents))
      this.parents.set(
        key,
        record.agent.parentId === null
          ? undefined
          : state.indexes.agentKeysById[record.agent.parentId],
      );
  }
  signal(agent: string | undefined, at: number, silenceMs: number): void {
    const ancestors = new Set<string>();
    let key: string | undefined = agent;
    while (key !== undefined && !ancestors.has(key)) {
      ancestors.add(key);
      key = this.parents.get(key);
    }
    const deadline = Math.floor(at + silenceMs) + 1;
    for (const entry of this.entries)
      if (
        entry.kind === "transport" ||
        (entry.kind === "silence" && (agent === undefined || ancestors.has(entry.key)))
      )
        entry.at = Math.max(entry.at, deadline);
  }
  next(providerDeadline?: number): number | undefined {
    return this.exited
      ? undefined
      : earliest(
          this.entries.map((entry) => entry.at),
          providerDeadline,
        );
  }
}
