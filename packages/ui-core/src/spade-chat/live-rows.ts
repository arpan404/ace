import type { SpadeAgent, SpadeAgentState } from "./agents.ts";
import type { SpadeGroupView } from "./group-fold.ts";
import type { SpadeGroup } from "./groups.ts";
import type { SpadeView } from "./view.ts";

/*
 * A list row while its conversation is open: drawn from the same live view the chat draws, so
 * the row and the chat never disagree (docs/design/spade.md §2). The roster, read every few
 * seconds, still speaks for every conversation that isn't open, and for what the open one's
 * stream can't say.
 */

/** What an open conversation's live view says of its agent's state, for the list row. */
export type SpadeLiveAgent =
  /** Its state as the chat shows it. */
  | {
      kind: "known";
      state: SpadeAgentState;
      waitingFor: SpadeAgent["waitingFor"];
      status: string | undefined;
    }
  /**
   * Nothing of its own is open (no reply, card, approval or job) and the stream hasn't said more
   * since: a wait on the person the roster still holds is over; the rest is the roster's.
   */
  | { kind: "settled" };

/** The open conversation's word on its agent; undefined until its stream has caught up. */
export function spadeLiveAgent(view: SpadeView): SpadeLiveAgent | undefined {
  if (!view.caughtUp) return undefined;
  const reported = view.reported;
  // The chat's own rules: a card or an approval open waits on the person, else anything open works.
  if (view.asking || view.approvals.length > 0)
    return {
      kind: "known",
      state: "waiting",
      waitingFor: view.asking ? "question" : "approval",
      status: reported?.state === "waiting" ? reported.status : undefined,
    };
  // A worker waiting on the person (ADR 0161) is the stream's to say, and waiting beats working.
  if (reported?.state === "waiting")
    return { kind: "known", state: "waiting", waitingFor: undefined, status: reported.status };
  if (view.busy)
    return { kind: "known", state: "working", waitingFor: undefined, status: view.status };
  if (reported)
    return {
      kind: "known",
      // Asleep on a wake reads as at work, as the roster lists it: never idle, never done.
      state: reported.state === "idle" ? "idle" : "working",
      waitingFor: undefined,
      status: reported.status,
    };
  return { kind: "settled" };
}

/** `agent` as its open conversation shows it (`spadeLiveAgent`); the roster's alone without. */
export function spadeWithLive<T extends SpadeAgent>(agent: T, live: SpadeLiveAgent | undefined): T {
  if (!live) return agent;
  if (live.kind === "settled") {
    if (agent.state !== "waiting" || agent.waitingFor === undefined) return agent;
    return { ...agent, state: "idle", waitingFor: undefined, status: undefined };
  }
  if (
    agent.state === live.state &&
    agent.waitingFor === live.waitingFor &&
    agent.status === live.status
  )
    return agent;
  return {
    ...agent,
    state: live.state,
    waitingFor: live.waitingFor,
    status: live.status,
    // Never unseen while it works or waits on the person.
    unseen: live.state === "idle" && agent.unseen,
  };
}

/** What an open group's live view says of its state; undefined until its stream has said. */
export type SpadeLiveGroup = Pick<SpadeGroup, "state" | "status">;

export function spadeLiveGroup(view: SpadeGroupView): SpadeLiveGroup | undefined {
  if (!view.live) return undefined;
  const state = view.state === "waiting" ? "waiting" : view.busy ? "working" : "idle";
  return { state, status: state === "idle" ? undefined : view.status };
}

/** `group` as its open conversation shows it (`spadeLiveGroup`); the roster's alone without. */
export function spadeGroupWithLive<T extends SpadeGroup>(
  group: T,
  live: SpadeLiveGroup | undefined,
): T {
  if (!live || (group.state === live.state && group.status === live.status)) return group;
  return {
    ...group,
    state: live.state,
    status: live.status,
    unseen: live.state === "idle" && group.unseen,
  };
}
