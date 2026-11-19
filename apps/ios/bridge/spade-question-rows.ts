import {
  spadeAnswerWords,
  spadeBubbles,
  spadeCardAnswers,
  spadeCardSettledWords,
  spadeEmptyDraft,
  spadeRefusedQuestion,
  type SpadeBubble,
  type SpadeDraft,
  type SpadeQuestion,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";

/*
 * A bot's card of questions (ADR 0154) as the iPhone draws it, and the card's answers checked
 * by the rules every client shares before they go to Spade. Pure: no I/O. Swift keeps what the
 * person has typed or picked as plain drafts and decides nothing.
 */

type Card = Extract<SpadeBubble, { kind: "question" }>;

/** One question of a card, with what its inputs need. */
export interface SpadeQuestionRow {
  prompt: string;
  kind: SpadeQuestion["kind"];
  placeholder: string | null;
  options: { label: string; detail: string | null }[];
  /** The person may write their own answer instead of picking. */
  other: boolean;
  /** `choices`: the most it takes, for "2 of 3 picked". */
  most: number | null;
  unit: string | null;
  /** `number`: it may be below zero, so its keypad needs a minus sign. */
  signed: boolean;
  /** `date`: the time is asked too. */
  time: boolean;
}

/** A card as the phone draws it. */
export interface SpadeQuestionCardRow {
  kind: "question";
  callId: string;
  /** "Builder asks: …" or "Builder asks 3 questions", for VoiceOver. */
  label: string;
  /** `open` waits on the person; `later` folds to one line until opened; `settled` is done. */
  standing: "open" | "later" | "settled";
  questions: SpadeQuestionRow[];
  /** Settled with answers: each question's answer in the person's words, in order. */
  answers: (string | null)[] | null;
  /** Settled without answers: how it ended ("Dismissed"). */
  line: string | null;
  /**
   * Settled only because its reply finished unanswered, not by its own answer or dismissal: an
   * update leaving it for later may have been missed, so the phone keeps its draft and lock.
   */
  closed: boolean;
}

/**
 * The most a `choices` question takes, as a whole count no larger than what can be picked: Swift
 * reads it as an `Int`, so a malformed `max` (2.5, 1e300) would fail the whole frame.
 */
function mostPicks(question: Extract<SpadeQuestion, { kind: "choices" }>): number {
  const possible = question.options.length + (question.other ? 1 : 0);
  return Math.max(0, Math.min(possible, Math.floor(question.max ?? possible)));
}

const questionRow = (question: SpadeQuestion): SpadeQuestionRow => ({
  prompt: question.prompt,
  kind: question.kind,
  placeholder: question.kind === "text" ? (question.placeholder ?? null) : null,
  options:
    question.kind === "choice" || question.kind === "choices"
      ? question.options.map((option) => ({ label: option.label, detail: option.detail ?? null }))
      : [],
  other: (question.kind === "choice" || question.kind === "choices") && question.other,
  most: question.kind === "choices" ? mostPicks(question) : null,
  unit: question.kind === "number" ? (question.unit ?? null) : null,
  signed: question.kind === "number" && (question.min === undefined || question.min < 0),
  time: question.kind === "date" && question.time,
});

export function spadeQuestionCardRow(card: Card, who: string): SpadeQuestionCardRow {
  const lone = card.questions.length === 1 ? card.questions[0] : undefined;
  const settled = card.standing !== "waiting" && card.standing !== "deferred";
  const answers = settled && card.standing === "answered" ? card.answers : undefined;
  return {
    kind: "question",
    callId: card.callId,
    label: lone ? `${who} asks: ${lone.prompt}` : `${who} asks ${card.questions.length} questions`,
    standing:
      card.standing === "waiting" ? "open" : card.standing === "deferred" ? "later" : "settled",
    questions: card.questions.map(questionRow),
    answers: answers
      ? card.questions.map((question, at) =>
          answers[at] === undefined ? null : spadeAnswerWords(question, answers[at]),
        )
      : null,
    line: settled && !answers ? spadeCardSettledWords(card) : null,
    closed: card.standing === "closed",
  };
}

/** What the card's inputs hold, one per question, as Swift sends them. */
export const SpadeDraftWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(20_000) }),
  z.object({
    kind: z.literal("picks"),
    picked: z.array(z.string().max(2_000)).max(64),
    other: z.string().max(20_000),
  }),
  z.object({ kind: z.literal("confirm"), value: z.boolean().optional() }),
  /**
   * `unread`: a number the phone couldn't read in its keyboard's locale (`1.500` on a German
   * keyboard is 1500 or 1.5), so it is asked for again, never guessed at.
   */
  z.object({ kind: z.literal("field"), text: z.string().max(200), unread: z.boolean().optional() }),
]);

/** The card's open questions, by its call, from what the conversation shows now. */
export function spadeOpenCard(view: SpadeView, callId: string): Card | undefined {
  for (const bubble of spadeBubbles(view))
    if (bubble.kind === "question" && bubble.callId === callId) return bubble;
  return undefined;
}

/**
 * The card's answers as Spade takes them, or the first question still missing one and why,
 * by its place in the card, so the card can turn to it.
 */
export function spadeCardReply(
  card: Card,
  drafts: readonly z.infer<typeof SpadeDraftWire>[],
): { answers: unknown[] } | { missing: string; at: number } {
  const read = spadeCardAnswers(
    card.questions,
    card.questions.map((question, at): SpadeDraft => {
      const draft = drafts[at];
      if (!draft) return spadeEmptyDraft(question);
      if (draft.kind === "confirm") return { kind: "confirm", value: draft.value };
      if (draft.kind === "field") return { kind: "field", text: draft.unread ? "" : draft.text };
      return draft;
    }),
  );
  return "missing" in read ? { missing: `${read.missing}.`, at: read.at } : read;
}

/** The question Spade's refusal names, when it names one on this card. */
export const spadeRefusedAt = (card: Card, refusal: string) =>
  spadeRefusedQuestion(refusal, card.questions.length);
