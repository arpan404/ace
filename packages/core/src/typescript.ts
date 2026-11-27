// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript reducer alone, with no backend switch. ADR 0223 scopes `ACE_CORE` to tests,
 * tools and the fake daemon; the daemon's engine reads and folds its own `ThreadState` records,
 * so it imports the reducer's functions from here and never asks the facade which core runs.
 */
export { apply, FactBatch } from "./reduce.ts";
export { createThreadState } from "./state.ts";
export { completionRelevanceReader, deriveAgentStatus, deriveThreadStatus } from "./status.ts";
export { nextDeadline, DeadlineIndex } from "./deadlines.ts";
export { isActionableInteraction } from "./human.ts";
export type { AgentRecord, ApplyContext, CoreConfig, IdSource, ThreadState } from "./state.ts";
export type { Fact } from "./facts.ts";
