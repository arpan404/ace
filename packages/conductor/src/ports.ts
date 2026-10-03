import type { Completion, Effect, Fact, Gate, Lane, State } from "./schema.ts";

/** All effect ids are durable idempotency keys, including preparation and attachment.
 * Adapters validate external responses before returning facts. No credentials cross these ports. */
export interface EnginePort {
  start(key: string, lane: Lane, cwd: string, prompt: string): Promise<void>;
  fork(key: string, lane: Lane, sourceLaneId: string, cwd: string, prompt: string): Promise<void>;
  control(
    key: string,
    lane: Lane,
    action: "pause" | "resume" | "cancel" | "allow_destructive",
  ): Promise<Fact[]>;
}
export interface OrchestratorPort {
  attach(key: string, rootAgentId: string, lane: Lane): Promise<void>;
}
export interface GitPort {
  prepare(
    key: string,
    workspaceId: string,
    lane: Lane,
    source: Completion | null,
    dependencies: readonly Completion[],
  ): Promise<{ cwd: string }>;
  merge(
    key: string,
    completion: Completion,
  ): Promise<{ revision: string; conflict: string | null; trivial: boolean }>;
}
export interface ForgePort {
  openPR(key: string, completion: Completion): Promise<{ revision: string }>;
  verifyCI(key: string, revision: string): Promise<{ passed: boolean; summary: string }>;
}
export interface AccountsPort {
  /** Must preserve full transcript/history and return only when the replacement is attached. */
  migrate(key: string, lane: Lane, fromAccount: string): Promise<void>;
}
export interface VerificationPort {
  check(key: string, revision: string): Promise<{ passed: boolean; summary: string }>;
}
export interface InteractionPort {
  /** Persist the ace interaction and its notification intent atomically. */
  open(key: string, rootAgentId: string, gate: Gate): Promise<void>;
  close(key: string, gateId: string): Promise<void>;
}
export interface Ports {
  engine: EnginePort;
  orchestrator: OrchestratorPort;
  git: GitPort;
  forge: ForgePort;
  accounts: AccountsPort;
  verification: VerificationPort;
  interactions: InteractionPort;
}
export type Executor = (effect: Effect, state?: State) => Promise<Fact[]>;
