import type { ChildRow } from "./child-ledger.ts";

/*
 * Whether the person's open question about a child on another machine still stands (ADR 0099,
 * ADR 0153). Pure. Every poll closes a question its child's state no longer explains, so a
 * write that failed partway through a change never leaves a parent held by a question nobody
 * can answer.
 */

/** What the child's ledger row says, as far as its question goes. */
export interface QuestionFacts {
  settled: boolean;
  /** Its pairing is gone (`lost_at`). */
  unpaired: boolean;
  /** Settled, and still watched through its re-check window (`settled_at`). */
  watching: boolean;
  /** A Stop is under way. */
  stopping: boolean;
  /** Its machine stopped answering for a lease (`silent_since`). */
  silent: boolean;
}

export const questionFacts = (row: ChildRow): QuestionFacts => ({
  settled: row.settled === 1,
  unpaired: row.lost_at !== null,
  watching: row.settled_at !== null,
  stopping: row.stop_started_at !== null,
  silent: row.silent_since !== null,
});

/**
 * `keep` while the child is one the person is asked about: unsettled and unpaired, unsettled and
 * lost contact with no Stop under way, or settled and still watched with its machine unpaired.
 * Anything else (back in contact, stopping, settled, stopped tracking) is `close`.
 */
export function questionFate(child: QuestionFacts): "keep" | "close" {
  if (child.settled) return child.unpaired && child.watching ? "keep" : "close";
  if (child.unpaired) return "keep";
  return child.silent && !child.stopping ? "keep" : "close";
}
