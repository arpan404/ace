// SPDX-License-Identifier: Apache-2.0
/**
 * `@ace/core`'s public surface. With `ACE_CORE` unset this is today's
 * TypeScript; with `ACE_CORE=native` or `ACE_CORE=wasm` the reducer's
 * exports below serve over the native core through `./native.ts`, behind the
 * same interface and shapes. One switch, read once at this boundary.
 */
import type { AgentStatus, EventPayload, Interaction, ThreadId, ThreadStatus } from "@ace/protocol";
import type { ApplyContext, CoreConfig, ThreadState } from "./state.ts";
import type { RootAgentInit } from "./facts.ts";
import type { Fact } from "./facts.ts";
import { nativeCore } from "./backend.ts";

export { supportsPermissionMode } from "./permissions.ts";
export type * from "./facts.ts";
export type { ThreadState, AgentRecord, CoreConfig, ApplyContext, IdSource } from "./state.ts";
export {
  deriveAgentStatus as deriveAgentStatusTs,
  deriveThreadStatus as deriveThreadStatusTs,
  isSettled,
  completionRelevanceReader as completionRelevanceReaderTs,
} from "./status.ts";
export { holdsThread, leftRunning } from "./background-hold.ts";
export { ownerTurnFinished } from "./status-inputs.ts";
export { hasUnresponsiveAncestor } from "./liveness.ts";
export { isActionableInteraction as isActionableInteractionTs } from "./human.ts";
export { apply as applyTs, FactBatch as FactBatchTs } from "./reduce.ts";
export { createThreadState as createThreadStateTs } from "./state.ts";
export { nextDeadline as nextDeadlineTs, DeadlineIndex as DeadlineIndexTs } from "./deadlines.ts";
import { apply as applyTs, FactBatch as FactBatchTs } from "./reduce.ts";
import { createThreadState as createThreadStateTs } from "./state.ts";
import { nextDeadline as nextDeadlineTs, DeadlineIndex as DeadlineIndexTs } from "./deadlines.ts";
import {
  deriveAgentStatus as deriveAgentStatusTs,
  deriveThreadStatus as deriveThreadStatusTs,
  completionRelevanceReader as completionRelevanceReaderTs,
} from "./status.ts";
import { isActionableInteraction as isActionableInteractionTs } from "./human.ts";
import {
  createThreadState as createThreadStateNative,
  apply as applyNative,
  FactBatch as FactBatchNative,
  deriveAgentStatus as deriveAgentStatusNative,
  deriveThreadStatus as deriveThreadStatusNative,
  nextDeadline as nextDeadlineNative,
  DeadlineIndex as DeadlineIndexNative,
  isActionableInteraction as isActionableInteractionNative,
  completionRelevanceReader as completionRelevanceReaderNative,
} from "./native.ts";

/**
 * Every reducer export below asks for the backend at call time, not at import time: a browser
 * imports this module before `startFakeCore` chooses wasm.
 */

/** Fold one adapter fact; the caller owns the clock, id sequence and envelope. */
export function apply(state: ThreadState, fact: unknown, ctx: ApplyContext): EventPayload[] {
  return nativeCore() ? applyNative(state, fact, ctx) : applyTs(state, fact, ctx);
}
/** A provider frame commits atomically; see `FactBatch` in `reduce.ts`. */
export class FactBatch {
  private readonly inner: FactBatchTs | FactBatchNative;
  constructor(state: ThreadState, stableSignals?: { deadline: number | undefined }) {
    this.inner = nativeCore()
      ? new FactBatchNative(state, stableSignals)
      : new FactBatchTs(state, stableSignals);
  }
  apply(fact: Fact, ctx: ApplyContext): EventPayload[] {
    return this.inner.apply(fact, ctx);
  }
  flush(): EventPayload[] {
    return this.inner.flush();
  }
}
/** Create an empty thread state; the native one holds a `CoreThread`. */
export function createThreadState(init: {
  threadId: ThreadId;
  rootAgent?: RootAgentInit;
  config: CoreConfig;
  seed?: (state: ThreadState) => void;
}): ThreadState {
  return nativeCore() ? createThreadStateNative(init) : createThreadStateTs(init);
}
/** Derive one agent's status for the current fact, descendants first. */
export function deriveAgentStatus(state: ThreadState, key: string, now: number): AgentStatus {
  return nativeCore()
    ? deriveAgentStatusNative(state, key, now)
    : deriveAgentStatusTs(state, key, now);
}
/** Derive one thread's status from its agents. */
export function deriveThreadStatus(state: ThreadState): ThreadStatus {
  return nativeCore() ? deriveThreadStatusNative(state) : deriveThreadStatusTs(state);
}
/** The earliest injected instant at which a tick can change a status. */
export function nextDeadline(state: ThreadState, providerDeadline?: number): number | undefined {
  return nativeCore()
    ? nextDeadlineNative(state, providerDeadline)
    : nextDeadlineTs(state, providerDeadline);
}
/** Candidate eligibility changes at structural facts. */
export class DeadlineIndex {
  private readonly inner: DeadlineIndexTs | DeadlineIndexNative;
  constructor(state: ThreadState) {
    this.inner = nativeCore() ? new DeadlineIndexNative(state) : new DeadlineIndexTs(state);
  }
  rebuild(state: ThreadState): void {
    this.inner.rebuild(state);
  }
  signal(agent: string | undefined, at: number, silenceMs: number): void {
    this.inner.signal(agent, at, silenceMs);
  }
  next(providerDeadline?: number): number | undefined {
    return this.inner.next(providerDeadline);
  }
}
/** The same human attention rule governs thread status and notification links. */
export function isActionableInteraction(
  interaction: Pick<Interaction, "state" | "blocking">,
  owner: Pick<AgentStatus, "state"> | undefined,
): boolean {
  return nativeCore()
    ? isActionableInteractionNative(interaction, owner)
    : isActionableInteractionTs(interaction, owner);
}
/** Read completion evidence from an already-derived, persisted agent tree. */
export function completionRelevanceReader(state: ThreadState): (key: string) => boolean {
  return nativeCore() ? completionRelevanceReaderNative(state) : completionRelevanceReaderTs(state);
}

/** Write one top-level state field (a native view writes it into the handle). */
export { setStateField } from "./native-state.ts";

/** Boot a browser's core (the fake daemon always runs on wasm). */
export { startFakeCore } from "./native.ts";
/** Choose the reducer backend explicitly (a browser's fake daemon calls this). */
export { useCoreBackend, type CoreBackend } from "./backend.ts";

export { externalAgentStatus, readyForChildResults } from "./external.ts";
export { acceptsPersonInput, compactionBlocked, continueMessage } from "./person-input.ts";

export { ExpiryMap } from "./expiry-map.ts";
export {
  providerCommandDisabled,
  type ProviderAdmissionFacts,
  type ProviderThread,
} from "./provider-admission.ts";

export { factRaw } from "./fact-raw.ts";

export { providerReadiness, onboardingChecklist } from "./provider-readiness.ts";

export {
  aceToolName,
  aceToolInput,
  normalizeAceCall,
  privateAceInput,
  redactAceArguments,
  redactAceApproval,
} from "./ace-tools.ts";

export { planStorageItem, type StorageCandidate } from "./storage-retention.ts";

export {
  switchRoute,
  switchRoutePreservingSource,
  type SwitchRoute,
  type SwitchSide,
} from "./switch-route.ts";

export {
  isRunningShellTool,
  hasForegroundShellCommand,
  hasRunningForegroundCommand,
  hasRunningForegroundCommandInTree,
} from "./steering.ts";
