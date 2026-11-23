// SPDX-License-Identifier: Apache-2.0
/**
 * `@ace/core`'s public surface. With `ACE_CORE` unset this is today's
 * TypeScript; with `ACE_CORE=native` or `ACE_CORE=wasm` the reducer's
 * exports below serve over the native core through `./native.ts`, behind the
 * same interface and shapes. One switch, read once at this boundary.
 */
import { coreBackend } from "@ace/provider-kit/native-switches";

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
export {
  apply as applyTs,
  FactBatch as FactBatchTs,
} from "./reduce.ts";
export { createThreadState as createThreadStateTs } from "./state.ts";
export { nextDeadline as nextDeadlineTs, DeadlineIndex as DeadlineIndexTs } from "./deadlines.ts";
import {
  apply as applyTs,
  FactBatch as FactBatchTs,
} from "./reduce.ts";
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

const useNative = coreBackend() !== "typescript";

/** Fold one adapter fact; the caller owns the clock, id sequence and envelope. */
export const apply = useNative ? applyNative : applyTs;
/** A provider frame commits atomically; see `FactBatch` in `reduce.ts`. */
export const FactBatch = useNative ? FactBatchNative : FactBatchTs;
/** Create an empty thread state; the native one holds a `CoreThread`. */
export const createThreadState = useNative ? createThreadStateNative : createThreadStateTs;
/** Derive one agent's status for the current fact, descendants first. */
export const deriveAgentStatus = useNative ? deriveAgentStatusNative : deriveAgentStatusTs;
/** Derive one thread's status from its agents. */
export const deriveThreadStatus = useNative ? deriveThreadStatusNative : deriveThreadStatusTs;
/** The earliest injected instant at which a tick can change a status. */
export const nextDeadline = useNative ? nextDeadlineNative : nextDeadlineTs;
/** Candidate eligibility changes at structural facts. */
export const DeadlineIndex = useNative ? DeadlineIndexNative : DeadlineIndexTs;
/** The same human attention rule governs thread status and notification links. */
export const isActionableInteraction = useNative
  ? isActionableInteractionNative
  : isActionableInteractionTs;
/** Read completion evidence from an already-derived, persisted agent tree. */
export const completionRelevanceReader = useNative
  ? completionRelevanceReaderNative
  : completionRelevanceReaderTs;

export { readyForChildResults } from "./external.ts";
export { acceptsPersonInput, continueMessage } from "./person-input.ts";

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
} from "./steering.ts";
