import type { Item, ProviderKind } from "@ace/protocol";

/*
 * Inputs ace sends a provider on the person's behalf (question answers, delegation results,
 * handoffs, restart and limit resumes, task prompts) come back as user messages. They are never
 * the person's words (IR-8/9/10/11, A3): the transcript shows them as a quiet divider or a card.
 * Messages carry `origin` once the daemon stamps it (C-A); until then, and for history written
 * before it, ace's own fixed texts are recognised exactly. Pure.
 */

export type InputKind =
  | "interaction_answer"
  | "subagent_result"
  | "handoff"
  | "spawn"
  | "parent_agent"
  | "restart"
  | "limit_resume"
  | "automation"
  | "schedule"
  | "background_completion";

/** The parts of a message's `origin` the UI reads. */
export interface OriginLike {
  kind: string;
  /** The person's send this message is, when it is one. */
  commandId?: string | undefined;
  interactionId?: string | undefined;
  threadIds?: readonly string[] | undefined;
  parentThreadId?: string | undefined;
  role?: string | undefined;
  from?: { provider: ProviderKind; model?: string | undefined } | undefined;
  to?: { provider: ProviderKind; model?: string | undefined } | undefined;
  lossy?: boolean | undefined;
}

/** A message's `origin`, read structurally so history from before the field still parses. */
export function messageOrigin(item: Item | undefined): OriginLike | undefined {
  if (item?.type !== "message" || !("origin" in item)) return undefined;
  const origin: unknown = (item as { origin?: unknown }).origin;
  if (typeof origin !== "object" || origin === null || !("kind" in origin)) return undefined;
  return typeof origin.kind === "string" ? (origin as OriginLike) : undefined;
}

export function messageText(item: Item): string {
  return item.type === "message"
    ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
}

export interface SystemInput {
  kind: InputKind;
  origin?: OriginLike | undefined;
  /** What the model received, for "What the agent received". */
  text: string;
}

const candidates = [
  "ace restarted.",
  "ace is resuming after a provider usage limit.",
  "Delegated agents settled.",
];

/**
 * Cheap first look, for the bubble/event choice at first paint: a message that may be ace's
 * input (an origin other than the person's, or text starting like one of ace's fixed inputs).
 * `systemInput` (system-events.ts, loaded with the event views) decides exactly; anything it
 * rejects renders as the person's bubble.
 */
export function mayBeSystemInput(item: Item | undefined): boolean {
  if (item?.type !== "message" || item.role === "assistant") return false;
  const origin = messageOrigin(item);
  if (origin) return origin.kind !== "person" && origin.kind !== "queue";
  const text = messageText(item).trimStart();
  return candidates.some((start) => text.startsWith(start));
}
