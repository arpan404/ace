/*
 * Where a thread carries on when the person picks another provider, model or account for it.
 * Pure: the daemon refuses a switch with it and clients route the next message with it, so both
 * always agree on which changes stay in the thread.
 */

/** The side of a switch: the thread as it runs now, or the selection it moves to. */
export interface SwitchSide {
  provider: string;
  /** The account (provider instance); undefined keeps the current one. */
  instanceId?: string | undefined;
  /** The transport the thread's native session lives on (`cursor-sdk`, `acp`). */
  backend?: string | undefined;
  /** The ACP agent: a selection must name one to enter ACP or change agent. */
  acpAgentId?: string | undefined;
}

/**
 * - `in_place`: the thread itself continues on the new selection (ADR 0051): a model change
 *   keeps the native session, another provider starts fresh with portable context.
 * - `new_thread`: a Cursor SDK checkpoint is pinned to its thread and account (ADR 0043), so
 *   leaving Cursor or changing its account continues in a portable fork; this thread is kept.
 * - `unsupported`: a selection that doesn't name the ACP agent it enters: an agent runs only on
 *   its registered identity. Named, any thread can move to an ACP agent and an ACP thread can
 *   change agent, continuing with a context handoff as for another provider.
 */
export type SwitchRoute = "in_place" | "new_thread" | "unsupported";

function otherAccount(current: SwitchSide, next: SwitchSide): boolean {
  return next.instanceId !== undefined && next.instanceId !== current.instanceId;
}

export function switchRoute(current: SwitchSide, next: SwitchSide): SwitchRoute {
  const accountChanged = otherAccount(current, next);
  if (next.provider === "acp" && !next.acpAgentId && (current.provider !== "acp" || accountChanged))
    return "unsupported";
  if (current.backend === "cursor-sdk" && (next.provider !== current.provider || accountChanged))
    return "new_thread";
  if (current.provider === "cursor" && next.provider === "cursor" && accountChanged)
    return "new_thread";
  return "in_place";
}

/** The person's switch preference preserves the source when the provider or account changes. */
export function switchRoutePreservingSource(current: SwitchSide, next: SwitchSide): SwitchRoute {
  const route = switchRoute(current, next);
  return route === "in_place" && (current.provider !== next.provider || otherAccount(current, next))
    ? "new_thread"
    : route;
}
