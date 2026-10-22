import type { InteractionRequest, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/**
 * How many restarts in a row may interrupt the same turn before ace stops continuing it by
 * itself. A turn that keeps dying across restarts (a daemon crash it triggers, say) waits for
 * the person after this many automatic continuations.
 */
export const maxRestartResumes = 3;

/** What startup knows about one thread whose provider work a restart may have cut short. */
export interface RestartFacts {
  /** A turn, background shell, subagent or provider queue was live when ace stopped. */
  wasRunning: boolean;
  /** Something already held the queue before this restart: a Stop, a pause, a limit, an earlier hold. */
  heldBefore: boolean;
  settled: boolean;
  archived: boolean;
  /** Title of a request the agent was waiting on the person to answer, if any. */
  waitingOnPerson: string | undefined;
  /** Input whose delivery a crash left uncertain; the person reviews it first. */
  uncertain: boolean;
  /** The provider can reopen the same native session. */
  canContinue: boolean;
  /** Automatic restart continuations in a row, without a completed turn or new input between. */
  streak: number;
}

export type RestartDecision =
  | { kind: "none" }
  | { kind: "resume" }
  | { kind: "hold"; why: "person" | "loop" | "unsupported" | "uncertain" };

/** Pure rule: continue the interrupted work by itself only when that is safe and wanted. */
export function restartDecision(facts: RestartFacts): RestartDecision {
  if (!facts.wasRunning || facts.heldBefore || facts.settled || facts.archived)
    return { kind: "none" };
  if (facts.waitingOnPerson !== undefined) return { kind: "hold", why: "person" };
  if (facts.uncertain) return { kind: "hold", why: "uncertain" };
  if (!facts.canContinue) return { kind: "hold", why: "unsupported" };
  if (facts.streak >= maxRestartResumes) return { kind: "hold", why: "loop" };
  return { kind: "resume" };
}

/** The transcript notice for a decision; every restart that interrupted work writes one. */
export function restartNoticeText(decision: RestartDecision, request?: string): string {
  if (decision.kind !== "hold") return "Interrupted by a restart. Continuing.";
  switch (decision.why) {
    case "person":
      return `Interrupted by a restart while waiting for your answer${request ? ` to "${request.slice(0, 160)}"` : ""}. Continue and the agent asks again.`;
    case "uncertain":
      return "Interrupted by a restart while a message was being sent. Review it, then continue.";
    case "unsupported":
      return "Interrupted by a restart. This agent can't pick its session back up by itself; send a message to carry on.";
    case "loop":
      return `Interrupted by a restart ${maxRestartResumes} times in a row, so ace stopped continuing it by itself. Continue when ready.`;
  }
}

const restartInstruction =
  "ace restarted while you were working, so your turn was cut short. Background shell commands, monitors and subagents you started have stopped, and any request you were waiting on has expired. Check the state of your work (files, git status, delegated agents, anything you were waiting on), rerun what was cut short instead of assuming it finished, then continue the task.";

/** The input a restart continuation sends, naming the background work that died. */
export function restartContinuation(lost: readonly string[]): string {
  const lines = lost.slice(0, 64);
  return `${restartInstruction}${lines.length ? `\nThese were running and have stopped:\n${lines.join("\n")}` : ""}`.slice(
    0,
    16384,
  );
}

/** Durable per-thread count of automatic restart continuations in a row. */
export class RestartStreaks {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_restart_resumes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        streak INTEGER NOT NULL
      )`),
    );
  }
  get(id: ThreadId): number {
    const row = this.store
      .statement("SELECT streak FROM engine_restart_resumes WHERE thread_id=?")
      .get(id);
    return typeof row?.streak === "number" ? row.streak : 0;
  }
  increment(id: ThreadId): void {
    this.store
      .statement(
        "INSERT INTO engine_restart_resumes(thread_id,streak) VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET streak=streak+1",
      )
      .run(id);
  }
  /** A completed turn or new input from someone ends the run of restarts. */
  clear(id: ThreadId): void {
    this.store.statement("DELETE FROM engine_restart_resumes WHERE thread_id=?").run(id);
  }
}

/** One line naming what an open request asked the person. */
export function requestLine(request: InteractionRequest): string {
  const text =
    request.kind === "question"
      ? request.questions[0]?.text
      : request.kind === "approval"
        ? request.title
        : request.title;
  return (
    text
      ?.split("\n")
      .find((part) => part.trim())
      ?.trim() ?? request.kind.replace("_", " ")
  );
}
