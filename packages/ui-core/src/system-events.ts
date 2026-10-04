import type { Item, ProviderKind } from "@ace/protocol";
import { modelLabel, providerNames } from "./providers.ts";

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

/* ---------------------------------------------------------------------------------------- */

export type EventIcon = "restart" | "resume" | "background" | "queue" | "switch" | "automation";

/** One quiet divider: "Resumed after restart", "Switched to Codex · GPT-5 Codex". */
export interface EventLine {
  icon: EventIcon;
  text: string;
  /** A muted second line: "Codex continues from a summary of this thread". */
  note?: string | undefined;
  /** Who the divider is about, for provider icons. */
  provider?: ProviderKind | undefined;
}

const selectionLabel = (side: { provider: ProviderKind; model?: string | undefined }) =>
  side.model
    ? `${providerNames[side.provider]} · ${modelLabel(side.model)}`
    : providerNames[side.provider];

/** "Switched to Codex · GPT-5 Codex", or "Model: Opus 4.1 → Sonnet 4.5" within one provider. */
export function switchLine(
  from: OriginLike["from"],
  to: NonNullable<OriginLike["to"]>,
  lossy: boolean,
): EventLine {
  if (from && from.provider === to.provider && from.model && to.model && from.model !== to.model)
    return {
      icon: "switch",
      text: `Model: ${modelLabel(from.model)} → ${modelLabel(to.model)}`,
      provider: to.provider,
    };
  return {
    icon: "switch",
    text: `Switched to ${selectionLabel(to)}`,
    note: lossy
      ? `${providerNames[to.provider]} continues from a summary of this thread`
      : undefined,
    provider: to.provider,
  };
}

/** The divider for an ace input shown as one line; undefined for the kinds that are cards. */
export function inputLine(input: SystemInput): EventLine | undefined {
  switch (input.kind) {
    case "restart":
      return { icon: "restart", text: "Resumed after restart" };
    case "limit_resume":
      return { icon: "resume", text: "Resumed after the usage limit" };
    case "queue":
      return { icon: "queue", text: "Queued message sent" };
    case "background_completion": {
      const title = /`([^`\n]+)`/.exec(input.text)?.[1];
      return {
        icon: "background",
        text: title ? `Background task finished: ${title}` : "Background task finished",
      };
    }
    case "schedule":
      return { icon: "automation", text: "Scheduled run started" };
    case "handoff": {
      const to = input.origin?.to;
      if (to) return switchLine(input.origin?.from, to, input.origin?.lossy ?? true);
      return {
        icon: "switch",
        text: "Continued from another thread",
        note: "The agent got a summary of it",
      };
    }
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------------------------------- */

export interface DelegationResult {
  threadId: string;
  outcome: "completed" | "failed" | "cancelled";
  result: string;
  truncated: boolean;
}

function asResult(value: unknown): DelegationResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const outcome = record["outcome"];
  if (typeof record["threadId"] !== "string") return undefined;
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") return undefined;
  return {
    threadId: record["threadId"],
    outcome,
    result: typeof record["result"] === "string" ? record["result"] : "",
    truncated: record["truncated"] === true,
  };
}

/** The children's results in a delegation-result input: one JSON object per line. */
export function parseDelegationResults(text: string): DelegationResult[] {
  return text.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const result = asResult(JSON.parse(line));
      return result ? [result] : [];
    } catch {
      return [];
    }
  });
}

/** The results of a `delegation.settled` item (#116), read structurally. */
export function settledResults(item: Item | undefined): DelegationResult[] | undefined {
  if (!item || (item.type as string) !== "delegation.settled") return undefined;
  const results: unknown = (item as { results?: unknown }).results;
  return Array.isArray(results) ? results.flatMap((value) => asResult(value) ?? []) : [];
}

/** The first line of a child's result, the readable part of a summary. */
export function resultLead(result: string, max = 180): string {
  const line =
    result
      .split("\n")
      .map((part) => part.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface TaskPrompt {
  /** "Task from", "Deck card", "Handoff from", "Automation". */
  label: string;
  role?: string | undefined;
  task: string;
  parentThreadId?: string | undefined;
}

/** A prompt ace started a thread with ("Role: greeter\n\nTask:\n…") as its parts. */
export function taskPrompt(input: SystemInput): TaskPrompt | undefined {
  const match = /^Role: ([^\n]*)\n\nTask:\n([\s\S]*)$/.exec(input.text.trimStart());
  const role = input.origin?.role ?? match?.[1];
  const task = (match?.[2] ?? input.text).trim();
  switch (input.kind) {
    case "spawn":
      return role?.startsWith("handoff: ")
        ? {
            label: "Handoff",
            role: role.slice(9),
            task,
            parentThreadId: input.origin?.parentThreadId,
          }
        : { label: "Task", role, task, parentThreadId: input.origin?.parentThreadId };
    case "parent_agent":
      return {
        label: "From the parent agent",
        role,
        task,
        parentThreadId: input.origin?.parentThreadId,
      };
    case "automation":
      return { label: "Automation", role, task };
    default:
      return undefined;
  }
}

/** A portable handoff's excerpts as readable text, for "Show summary". */
export function handoffSummary(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("excerpts" in parsed)) return undefined;
    const excerpts: unknown = parsed.excerpts;
    if (!Array.isArray(excerpts)) return undefined;
    const lines = excerpts.flatMap((excerpt: unknown) =>
      typeof excerpt === "object" &&
      excerpt !== null &&
      "text" in excerpt &&
      typeof excerpt.text === "string"
        ? [excerpt.text.trim()]
        : [],
    );
    return lines.filter(Boolean).join("\n\n") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The same ace event already shown just before `index` (A2: a restart writes a notice and the
 * provider echoes the input): only the first of them renders. Looks back a few items only.
 */
export function repeatsEarlierEvent(
  order: readonly string[],
  index: number,
  item: (id: string) => Item | undefined,
  kind: InputKind,
  span = 8,
): boolean {
  for (let at = index - 1; at >= Math.max(0, index - span); at--) {
    const earlier = item(order[at] ?? "");
    if (!earlier) continue;
    if (noticeInput(earlier) === kind || systemInput(earlier)?.kind === kind) return true;
    // Real work in between means it happened again.
    if (
      earlier.type === "tool_call" ||
      (earlier.type === "message" && earlier.role === "assistant")
    )
      return false;
  }
  return false;
}
