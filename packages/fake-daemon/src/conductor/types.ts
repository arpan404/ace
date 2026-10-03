import type { ProviderKind } from "@ace/protocol";

/*
 * Seed and scenario state. FakePlanningWire maps it to the canonical ConductorRunView.
 */

export type FakeCardState =
  | "planned"
  | "working"
  | "in_review"
  | "fixing"
  | "escalated"
  | "merged"
  /** The final merge card: waits for every other card. */
  | "merge";

export interface FakeFinding {
  severity: "high" | "medium" | "low";
  text: string;
}
export interface FakeRound {
  label: string;
  verdict: string;
  detail: string;
  findings: FakeFinding[];
}
export interface FakeRole {
  /** An account id the fake `accounts.list` serves ("codex-personal"). */
  account: string;
  provider: ProviderKind;
  detail: string;
}
export interface FakeLane {
  worker: FakeRole;
  reviewer: FakeRole;
  threadId: string | null;
  rounds: FakeRound[];
}
export interface FakeDeckCard {
  id: string;
  /** The final card that merges the deck's branch. */
  kind: "work" | "merge";
  title: string;
  dependencies: string[];
  state: FakeCardState;
  round: number;
  lane: FakeLane | null;
  /** One sentence for cards without a lane (planned, merged, merge). */
  note: string;
}
export interface FakePlanChange {
  kind: "moved" | "added" | "removed" | "changed";
  cardId: string;
  title: string;
  detail: string;
  /** For an added card. */
  dependencies?: string[];
}
export interface FakeGate {
  id: string;
  kind: "plan" | "merge" | "escalation";
  title: string;
  body: string;
  revision: number;
  changes: FakePlanChange[];
}
export type FakeDeckPhase =
  | "planning"
  | "dealing"
  | "merging"
  | "merged"
  | "paused"
  | "cancelled"
  | "failed";
export interface FakeLogEntry {
  at: number;
  text: string;
}
export interface FakeDeckRun {
  id: string;
  title: string;
  goal: string;
  workspaceId: string;
  branch: string;
  phase: FakeDeckPhase;
  /** At least one plan revision was approved. */
  planApproved: boolean;
  gate: FakeGate | null;
  /** Column names by dependency depth (Foundation, Build, …). */
  stages: string[];
  cards: FakeDeckCard[];
  log: FakeLogEntry[];
  pullRequest: number | null;
  createdAt: number;
  updatedAt: number;
}
