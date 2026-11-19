import type { EventPayload, Run } from "@ace/protocol";
import type { ThreadView } from "@ace/projection";
import { startedRunTurn, startsTurn } from "@ace/projection";

/**
 * The fake daemon's root-run turn numbers, by the daemon's rule (ADR 0062): a root run opens the
 * next turn only when an ask (`startsTurn`) is waiting that no started run took, or its trigger
 * says it was asked for; otherwise it joins the current turn.
 */
export class RunTurns {
  private current: number | undefined;
  private readonly asks = new Set<string>();
  private readonly runs = new Map<string, number>();

  /** Follows root messages: a waiting ask, or one a started run took or withdrew. */
  track(payload: EventPayload, rootAgentId: string | undefined): void {
    if (payload.type === "item.deleted") {
      this.asks.delete(payload.itemId);
      return;
    }
    if (payload.type !== "item.created" && payload.type !== "item.updated") return;
    const item = payload.item;
    if (item.agentId !== rootAgentId || !startsTurn(item)) return;
    if (item.runId !== undefined && this.runs.has(item.runId)) this.asks.delete(item.id);
    else if (payload.type === "item.created") this.asks.add(item.id);
  }

  /** The root run's turn, allocated once. */
  start(run: Pick<Run, "id" | "trigger">): number {
    const known = this.runs.get(run.id);
    if (known !== undefined) return known;
    const turn = startedRunTurn({
      current: this.current,
      legacyBase: 0,
      asked: this.asks.size > 0,
      trigger: run.trigger,
    });
    this.current = turn;
    this.asks.clear();
    this.runs.set(run.id, turn);
    return turn;
  }
}

/** What numbering a root run needs from its thread's host. */
export interface RunNumbering {
  readonly view: Pick<ThreadView, "thread" | "runs">;
  readonly turns: RunTurns;
  runOrdinal: number;
}

/**
 * A root run's start with its turn and ordinal, as the daemon numbers it before anything else
 * reads it; every other payload unchanged. The caller has tracked the payload's asks first.
 */
export function numberedRun(host: RunNumbering, payload: EventPayload): EventPayload {
  if (payload.type !== "run.started" || payload.run.agentId !== host.view.thread.rootAgentId)
    return payload;
  const run = payload.run;
  return {
    ...payload,
    run: {
      ...run,
      turn: host.turns.start(run),
      ordinal: host.view.runs[run.id]?.ordinal ?? ++host.runOrdinal,
      checkpoints: { state: "unavailable", error: "scripted_provider" },
    },
  };
}
