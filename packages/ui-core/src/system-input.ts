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
  | "queue"
  | "automation"
  | "schedule"
  | "background_completion";

/** The parts of a message's `origin` the UI reads. */
export interface OriginLike {
  kind: string;
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

const restartText = /^ace restarted\./;
const limitText = /^ace is resuming after a provider usage limit\./;
const resultText = /^Delegated agents settled\./;
const spawnText = /^Role: [^\n]*\n\nTask:\n/;
const handoffKeys = ["version", "sourceThreadId", "excerpts", "policy"];

function looksLikeHandoff(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" && parsed !== null && handoffKeys.every((key) => key in parsed)
    );
  } catch {
    return false;
  }
}

/** ace's own fixed inputs, recognised by their exact wording, for history without `origin`. */
function knownInput(text: string): InputKind | undefined {
  if (restartText.test(text)) return "restart";
  if (limitText.test(text)) return "limit_resume";
  if (resultText.test(text)) return "subagent_result";
  if (spawnText.test(text)) return "spawn";
  if (looksLikeHandoff(text)) return "handoff";
  return undefined;
}

const inputKinds = new Set<string>([
  "interaction_answer",
  "subagent_result",
  "handoff",
  "spawn",
  "parent_agent",
  "restart",
  "limit_resume",
  "queue",
  "automation",
  "schedule",
  "background_completion",
]);

/**
 * The ace input a message carries, or undefined for the person's own words. Applies to user
 * messages and to synthetic ones; assistant prose is never an input.
 */
export function systemInput(item: Item | undefined): SystemInput | undefined {
  if (item?.type !== "message" || item.role === "assistant") return undefined;
  const text = messageText(item);
  const origin = messageOrigin(item);
  if (origin) {
    if (origin.kind === "person") return undefined;
    if (inputKinds.has(origin.kind)) return { kind: origin.kind as InputKind, origin, text };
  }
  const known = knownInput(text.trimStart());
  return known ? { kind: known, origin, text } : undefined;
}

/** A notice ace writes beside its own input ("ace restarted…"): the same event, once. */
export function noticeInput(item: Item | undefined): InputKind | undefined {
  if (item?.type !== "notice") return undefined;
  const text = item.text.trimStart();
  if (restartText.test(text)) return "restart";
  if (limitText.test(text)) return "limit_resume";
  return undefined;
}
