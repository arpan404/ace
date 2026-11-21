import { z } from "zod";

/*
 * Cases (ADR 0204 §1): finished runs the person kept as tests, on the bot's own machine. The
 * person keeps one from a reply's More menu, after a review of what will be written (already
 * redacted by Spade, with room to mark more to hide), and sees a bot's cases in its profile.
 * Spade's `GET /v1/agents/{id}/cases` and `POST /v1/agents/{id}/cases/preview` read here.
 */

export type SpadeCaseMark = "right" | "wrong";

const words = z.string().catch("").default("");
const mark = z.enum(["right", "wrong"]).nullish().catch(undefined);
const trigger = z
  .object({ kind: words, name: z.string().nullish().catch(undefined) })
  .catch({ kind: "message", name: undefined });

const summary = z.object({
  id: z.string(),
  reply: words,
  mark,
  why: z.string().nullish().catch(undefined),
  trigger,
  given: words,
  outcome: words,
  made_at: z.number().catch(0),
});

export interface SpadeCaseSummary {
  id: string;
  reply: string;
  mark: SpadeCaseMark | undefined;
  why: string | undefined;
  trigger: { kind: string; name: string | undefined };
  /** The message it answered, on one line. */
  given: string;
  /** What it answered, on one line. */
  outcome: string;
  madeAt: number;
}

function toSummary(row: z.output<typeof summary>): SpadeCaseSummary {
  return {
    id: row.id,
    reply: row.reply,
    mark: row.mark ?? undefined,
    why: row.why ?? undefined,
    trigger: { kind: row.trigger.kind, name: row.trigger.name ?? undefined },
    given: row.given,
    outcome: row.outcome,
    madeAt: row.made_at,
  };
}

/** A bot's kept cases from `{cases}`, newest first; rows that don't read are left out. */
export function parseSpadeCases(body: unknown): readonly SpadeCaseSummary[] | undefined {
  const parsed = z.object({ cases: z.array(z.unknown()) }).safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data.cases.flatMap((row) => {
    const one = summary.safeParse(row);
    return one.success ? [toSummary(one.data)] : [];
  });
}

/** The kept case's summary from a keep's `{summary, case}`. */
export function parseSpadeKeptCase(body: unknown): SpadeCaseSummary | undefined {
  const parsed = z.object({ summary }).safeParse(body);
  return parsed.success ? toSummary(parsed.data.summary) : undefined;
}

const result = z.object({
  tool: words,
  content: words,
  is_error: z.boolean().catch(false).default(false),
});

const draft = z.object({
  case: z.object({
    given: z
      .object({ messages: z.array(z.string()).catch([]).default([]) })
      .catch({ messages: [] }),
    tool_results: z.array(result).catch([]).default([]),
    outcome: z.object({ text: words }).catch({ text: "" }),
  }),
});

/** One line of the review: what kind of thing it is, and its words as they will be kept. */
export interface SpadeCaseReviewLine {
  key: string;
  label: string;
  text: string;
}

/**
 * The review shown before a case is kept, from `POST …/cases/preview`: what it was given, each
 * outside answer by its tool, and the reply, as Spade will write them.
 */
export function parseSpadeCaseReview(body: unknown): readonly SpadeCaseReviewLine[] | undefined {
  const parsed = draft.safeParse(body);
  if (!parsed.success) return undefined;
  const { given, tool_results: results, outcome } = parsed.data.case;
  return [
    ...given.messages.map((text, i) => ({ key: `given:${i}`, label: "Asked", text })),
    ...results.map((r, i) => ({
      key: `answer:${i}`,
      label: r.is_error ? `${r.tool} failed` : r.tool,
      text: r.content,
    })),
    { key: "outcome", label: "Answered", text: outcome.text },
  ];
}

/** "Marked right", "Marked wrong", or nothing for a case kept without a mark. */
export function spadeCaseMarkWords(mark: SpadeCaseMark | undefined): string | undefined {
  if (mark === "right") return "Marked right";
  if (mark === "wrong") return "Marked wrong";
  return undefined;
}

/** What started the run, in a few words: "From Morning fares", "From Flight watcher". */
export function spadeCaseTriggerWords(trigger: SpadeCaseSummary["trigger"]): string | undefined {
  if (trigger.kind === "message" || !trigger.name) return undefined;
  if (trigger.kind === "contract") return `Asked for ${trigger.name}`;
  return `From ${trigger.name}`;
}
