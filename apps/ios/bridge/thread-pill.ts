import type { ChangeTap, ThreadSource } from "@ace/client";
import type { CommandPayload, GoalChange, ProviderGoal, ThreadId } from "@ace/protocol";
import { goalResumable, goalTitle, goalUsage, readTurnActivity } from "@ace/ui-core";
import { livePill } from "@ace/ui-core/mobile";
import { preview } from "./presentation.ts";

/*
 * The phone's live pill over the composer (`livePill` in `@ace/ui-core`): what the thread does
 * now and what else is live (subagents, commands, the queue, the goal), each part naming the
 * sheet it opens; and the goal's sheet, with the changes ace can make to it. Swift draws what this
 * sends and never decides any of it. Re-read when a key the pill was read from changes, or when
 * the queue's count moves.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

/** Membership keys that can move the pill, besides the root agent and what it last read. */
const always = ["order", "agents", "tasks", "queue", "interactions", "thread"];

/** The goal's sheet: its words, its progress and what ace can change. */
export function goalRow(goal: ProviderGoal | null | undefined, editable: boolean) {
  if (!goal) return null;
  return {
    title: goalTitle(goal.status),
    objective: preview(goal.objective, 4000),
    reason: goal.lastReason ? preview(`Not met yet: ${goal.lastReason}`, 4000) : "",
    usage: goalUsage(goal) ?? "",
    canPause: editable && goal.status === "active",
    canResume: editable && goalResumable(goal.status),
    canClear: editable,
  };
}

/** The daemon command for a change the goal's sheet offered, or undefined when it can't. */
export function goalPayload(
  threadId: ThreadId,
  goal: ProviderGoal | null | undefined,
  editable: boolean,
  change: "pause" | "resume" | "clear",
): CommandPayload | undefined {
  const row = goalRow(goal, editable);
  if (!row) return undefined;
  if (change === "clear") return row.canClear ? { type: "thread.goal.clear", threadId } : undefined;
  const next: GoalChange = { status: change === "pause" ? "paused" : "active" };
  const allowed = change === "pause" ? row.canPause : row.canResume;
  return allowed ? { type: "thread.goal.set", threadId, change: next } : undefined;
}

export class PillFollower {
  readonly #store: ThreadSource;
  readonly #put: Put;
  #queued = 0;
  #held = false;
  #watch = new Set<string>();

  constructor(store: ThreadSource, put: Put) {
    this.#store = store;
    this.#put = put;
  }

  /** The reader changed: emit when a key the pill was read from moved. */
  readonly tap: ChangeTap = (keys) => {
    if (keys === "all") return this.#emit();
    // A request opening or closing moves whether its card takes the pill's place.
    for (const key of keys)
      if (this.#watch.has(key) || key.startsWith("interaction:")) return this.#emit();
  };

  /** A request card is in the strip: Swift shows one for each of this thread's open requests. */
  #requestShown(): boolean {
    return this.#store
      .interactionIds()
      .some((id) => this.#store.interaction(id)?.state === "pending");
  }

  /** The queue was read again: its count is one of the pill's parts, and whether its strip says what holds the turn. */
  queued(count: number, held = this.#held): void {
    if (count === this.#queued && held === this.#held) return;
    this.#queued = count;
    this.#held = held;
    this.#emit();
  }

  /** Whether ace sets this provider's goals itself (the provider's own `/goal` otherwise). */
  get editable(): boolean {
    return this.#store.thread?.capabilities?.goals === true;
  }

  #emit(): void {
    this.#put("pill", () => {
      const thread = this.#store.thread;
      const rootId = thread?.rootAgentId ?? "";
      const reading = readTurnActivity(this.#store, rootId, { threadStatus: thread?.status });
      this.#watch = new Set([...always, `agent:${rootId}`, ...reading.watch]);
      const pill = livePill({
        activity: reading.activity,
        queued: this.#queued,
        goal: thread?.goal,
        requestShown: this.#requestShown(),
        holdShown: this.#held,
      });
      return {
        type: "thread.pill",
        pill: pill
          ? {
              status: pill.status
                ? {
                    label: preview(pill.status.label, 256),
                    lead: preview(pill.status.lead, 256),
                    since: pill.status.since ?? null,
                    code: preview(pill.status.code ?? "", 512),
                    live: pill.status.live,
                    tone: pill.status.tone,
                    opens: pill.status.opens ?? "",
                  }
                : null,
              segments: pill.segments.map((segment) => ({
                kind: segment.kind,
                label: preview(segment.label, 256),
                opens: segment.opens,
                live: segment.live,
              })),
            }
          : null,
        goal: goalRow(thread?.goal, this.editable),
      };
    });
  }
}
