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
  /** Passed review; waits for its merge. */
  | "approved"
  /** The person rejected its merge or escalation: it never merges. */
  | "declined"
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
  /** The plan's brief for the card: what it must do and how its reviewer judges it. */
  brief?: { objective: string; acceptance: string[] };
  /** The worker's open question to the person: a provider gate until it is answered. */
  question?: FakeQuestion | null;
}
export interface FakeQuestion {
  text: string;
  options: { id: string; label: string }[];
}
/**
 * The decision a deck waits on, as the conductor raises it (`packages/conductor`). Rejecting one
 * means what it means there: a plan is redrafted; a merge, escalation or destructive change on a
 * card declines that card; a budget, a deadline or a gate about no card stops the deck.
 */
export interface FakeGate {
  id: string;
  kind: "plan" | "merge" | "escalation" | "budget" | "deadline" | "destructive";
  /** The daemon's own sentence for the gate. */
  body: string;
  /** The card the gate is about, when it is about one. */
  cardId: string | null;
  /** The plan's draft number, for plan gates. */
  revision: number;
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
  /** Whether the plan waits for the person; seeded decks asked for approval. */
  planApproval?: "required" | "auto";
  gate: FakeGate | null;
  /** Column names by dependency depth (Foundation, Build, …). */
  stages: string[];
  cards: FakeDeckCard[];
  log: FakeLogEntry[];
  pullRequest: number | null;
  /** Lane starts reserved so far, and the most the deck may use. */
  spent: number;
  budget: number;
  /** When the deck stops starting work and asks; null or missing for no limit. */
  deadline?: number | null;
  createdAt: number;
  updatedAt: number;
  maxParallel?: number;
  hostCapacity?: number;
  retryAt?: number;
  retryFailures?: number;
  /** Why the conductor couldn't run the deck's next step; cleared when it resumes. */
  executionError?: string;
}

/** A staged deck the design's world doesn't hold (`deckRuns(now, extra)`). */
export type FakeDeckScenario = "planning" | "budget" | "unresponsive";
