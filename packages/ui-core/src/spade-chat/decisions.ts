import { z } from "zod";

/*
 * The decision log (ADR 0165): each choice a bot made on the person's behalf, stored as
 * `decision_made {decision, call_id, choice, reason, options, item?}` in its conversation.
 * Nothing waits on them; the person who disagrees says so, and Change quotes the decision into
 * their next message.
 */

export interface SpadeDecision {
  /** Spade's number for it in the conversation (`d1`, `d2`, …). */
  id: string;
  choice: string;
  reason: string;
  /** What it set aside. */
  options: readonly string[];
  /** The plan item it belongs to. */
  item: string | undefined;
  /** When it was stored (ms). */
  at: number;
}

const decisionShape = z.object({
  type: z.literal("decision_made"),
  decision: z.string().min(1),
  choice: z.string().min(1),
  reason: z.string().catch("").default(""),
  options: z.array(z.string()).catch([]).default([]),
  item: z.string().nullish().catch(undefined),
});

/** A stored event's body as a decision; undefined for any other event. */
export function parseSpadeDecision(raw: unknown, at: number): SpadeDecision | undefined {
  const parsed = decisionShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const { decision, choice, reason, options, item } = parsed.data;
  return { id: decision, choice, reason, options, item: item ?? undefined, at };
}

/** The newest first, one per id (a decision stored twice shows once). */
export function spadeDecisionsShown(decisions: readonly SpadeDecision[]): SpadeDecision[] {
  const seen = new Set<string>();
  const shown: SpadeDecision[] = [];
  for (const decision of decisions.toReversed()) {
    if (seen.has(decision.id)) continue;
    seen.add(decision.id);
    shown.push(decision);
  }
  return shown;
}

/** The person's next message, quoting the decision they want changed. */
export function spadeQuoted(quote: string, words: string): string {
  const quoted = quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return words.trim() ? `${quoted}\n\n${words}` : quoted;
}
