import { ExpiryMap } from "./expiry-map.ts";
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
  private silence = new ExpiryMap<undefined>();
  private wakes = new ExpiryMap<undefined>();
  private parents = new Map<string, string | undefined>();
  private globalSignalAt = 0;
  private transportAt: number | undefined;
  private exited = false;
  constructor(state: ThreadState) {
    this.rebuild(state);
  }
  rebuild(state: ThreadState): void {
    this.exited = state.processExit !== undefined;
    this.silence.clear();
    this.wakes.clear();
    this.globalSignalAt = 0;
    this.transportAt = undefined;
    for (const entry of candidates(state)) {
      if (entry.kind === "transport") this.transportAt = entry.at;
      else if (entry.kind === "silence") this.silence.set(entry.key, undefined, entry.at);
      else this.wakes.set(entry.key, undefined, entry.at);
    }
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
    const deadline = Math.floor(at + silenceMs) + 1;
    if (this.transportAt !== undefined) this.transportAt = Math.max(this.transportAt, deadline);
    if (agent === undefined) {
      this.globalSignalAt = Math.max(this.globalSignalAt, deadline);
      return;
    }
    const ancestors = new Set<string>();
    let key: string | undefined = agent;
    while (key !== undefined && !ancestors.has(key)) {
      ancestors.add(key);
      const entry = this.silence.deadline(key);
      if (entry !== undefined) this.silence.set(key, undefined, Math.max(entry, deadline));
      key = this.parents.get(key);
    }
  }
  next(providerDeadline?: number): number | undefined {
    if (this.exited) return;
    const silence = this.silence.first()?.expiresAt;
    const wake = this.wakes.first()?.expiresAt;
    return earliest(
      [
        ...(silence === undefined ? [] : [Math.max(silence, this.globalSignalAt)]),
        ...(wake === undefined ? [] : [wake]),
        ...(this.transportAt === undefined ? [] : [this.transportAt]),
      ],
      providerDeadline,
    );
  }
}
