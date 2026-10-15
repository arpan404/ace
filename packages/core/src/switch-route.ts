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
}

/**
 * - `in_place`: the thread itself continues on the new selection (ADR 0051): a model change
 *   keeps the native session, another provider starts fresh with portable context.
 * - `new_thread`: a Cursor SDK checkpoint is pinned to its thread and account (ADR 0043), so
 *   leaving Cursor or changing its account continues in a portable fork; this thread is kept.
 * - `unsupported`: an ACP agent needs the registered identity a thread is created with, so an
 *   existing thread of another provider can't move to one.
 */
export type SwitchRoute = "in_place" | "new_thread" | "unsupported";

export function switchRoute(current: SwitchSide, next: SwitchSide): SwitchRoute {
  if (next.provider === "acp" && current.provider !== "acp") return "unsupported";
  const otherAccount = next.instanceId !== undefined && next.instanceId !== current.instanceId;
  if (current.backend === "cursor-sdk" && (next.provider !== current.provider || otherAccount))
    return "new_thread";
  if (current.provider === "cursor" && next.provider === "cursor" && otherAccount)
    return "new_thread";
  return "in_place";
}
