import type { SpadeBubble } from "./bubbles.ts";
import type { SpadeEntry } from "./fold.ts";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Skills a bot proposes (ADR 0130): Spade's proposals parsed, placed in the chat after the reply
 * that made each, and an edit's changed lines.
 */

export type SpadeProposalState = "open" | "saved" | "discarded";

export interface SpadeProposal {
  id: string;
  /** The `skill_propose` call that made it. */
  callId: string;
  name: string;
  description: string;
  body: string;
  /** What the bot learned, in its words; may be empty. */
  why: string;
  /** The skill as it was, for an edit; undefined for a new skill. */
  base: { description: string; body: string } | undefined;
  state: SpadeProposalState;
  createdAt: number;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const states = new Set<string>(["open", "saved", "discarded"]);

function parseProposal(raw: unknown): SpadeProposal | undefined {
  const fields = spadeRecord(raw);
  if (!fields) return undefined;
  const [id, callId, name, body] = [fields.id, fields.call_id, fields.name, fields.body].map(text);
  const state = text(fields.state);
  if (!id || !callId || !name || body === undefined || !state || !states.has(state))
    return undefined;
  const base = spadeRecord(fields.base);
  return {
    id,
    callId,
    name,
    description: text(fields.description) ?? "",
    body,
    why: text(fields.why) ?? "",
    base: base
      ? { description: text(base.description) ?? "", body: text(base.body) ?? "" }
      : undefined,
    state: state as SpadeProposalState,
    createdAt: typeof fields.created_at === "number" ? fields.created_at : 0,
  };
}

/** `{"proposals": [...]}`; a proposal that doesn't parse is left out. */
export function parseSpadeProposals(body: string): SpadeProposal[] | undefined {
  const list = spadeRecord(spadeJson(body))?.proposals;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const proposal = parseProposal(raw);
    return proposal ? [proposal] : [];
  });
}

/** `{"proposal": ...}` from answering one. */
export function parseSpadeProposal(body: string): SpadeProposal | undefined {
  return parseProposal(spadeRecord(spadeJson(body))?.proposal);
}

export type SpadeChatItem = SpadeBubble | { kind: "skill"; key: string; proposal: SpadeProposal };

/**
 * The chat's bubbles with each proposal after the last bubble of the reply that made it (or of
 * the entries before it, when that reply said nothing), and before the approvals that wait at
 * the end. A proposal whose reply isn't loaded goes at the end, oldest first.
 */
export function withProposals(
  bubbles: readonly SpadeBubble[],
  entries: readonly SpadeEntry[],
  proposals: readonly SpadeProposal[],
): SpadeChatItem[] {
  if (!proposals.length) return [...bubbles];
  const entryAt = new Map(entries.map((entry, index) => [entry.key, index]));
  const callAt = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "reply") return;
    for (const part of entry.parts) if (part.kind === "call") callAt.set(part.key, index);
  });
  const placed = [...proposals]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((proposal) => ({ proposal, at: callAt.get(proposal.callId) ?? Infinity }));
  const items: SpadeChatItem[] = [];
  const drop = (upTo: number) => {
    while (placed.length && (placed[0]?.at ?? Infinity) <= upTo) {
      const next = placed.shift();
      if (next)
        items.push({ kind: "skill", key: `skill:${next.proposal.id}`, proposal: next.proposal });
    }
  };
  for (const bubble of bubbles) {
    const at = bubble.kind === "ask" ? Infinity : (entryAt.get(bubble.key) ?? Infinity);
    // Everything placed before this bubble's entry goes first.
    drop(at - 1);
    if (bubble.kind === "ask") drop(Infinity);
    items.push(bubble);
  }
  drop(Infinity);
  return items;
}

export type SpadeLineChange = { kind: "same" | "added" | "removed"; text: string };

/** Lines past which a diff isn't worked out line by line. */
const mostCells = 4_000_000;

/**
 * `before` to `after` line by line (longest common subsequence), or undefined when they are too
 * long to compare that way.
 */
export function spadeLineChanges(before: string, after: string): SpadeLineChange[] | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > mostCells) return undefined;
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
  const changes: SpadeLineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changes.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length || (common[i * width + j + 1] ?? 0) >= (common[(i + 1) * width + j] ?? 0))
    ) {
      changes.push({ kind: "added", text: b[j] ?? "" });
      j++;
    } else {
      changes.push({ kind: "removed", text: a[i] ?? "" });
      i++;
    }
  }
  return changes;
}
