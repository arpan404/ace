import { z } from "zod";

/*
 * A bot's questions (ADR 0154, spade/docs/questions.md): one card of one to five, each of a kind
 * with its own answer. Parsed leniently from `question_asked`; the card's answers worded for the
 * person; a draft checked as Spade checks it, so Send waits until it would be taken. Spade checks
 * again and has the last word.
 */

export interface SpadeQuestionOption {
  label: string;
  detail: string | undefined;
}

interface Base {
  /** The card's id for it, when the bot gave one. */
  id: string | undefined;
  prompt: string;
}

export type SpadeQuestion =
  | (Base & { kind: "text"; placeholder: string | undefined })
  | (Base & { kind: "choice"; options: readonly SpadeQuestionOption[]; other: boolean })
  | (Base & {
      kind: "choices";
      options: readonly SpadeQuestionOption[];
      min: number;
      max: number | undefined;
      other: boolean;
    })
  | (Base & { kind: "confirm" })
  | (Base & {
      kind: "number";
      min: number | undefined;
      max: number | undefined;
      unit: string | undefined;
    })
  | (Base & { kind: "date"; time: boolean })
  /** Connect an app (`app_connect_request`, ADR 0131 amendment 1): answered by connecting. */
  | (Base & { kind: "connect"; connect: SpadeConnectAsk });

/** How the person gives the bot the app a connect card asks for. */
export type SpadeConnectWay = "sign_in" | "key" | "later" | "use" | "reconnect";

/** The app a connect card asks for, as Spade made the card from its catalogue. */
export interface SpadeConnectAsk {
  /** Its catalogue id, or for a server added by address, its connector's. */
  app: string;
  name: string;
  way: SpadeConnectWay;
  /** What the bot may do with it, a few words each. */
  can: readonly string[];
  /** The person's connector for it already (`use`, `reconnect`). */
  connector: string | undefined;
  /** Where the person makes a key (`key`); https only. */
  keyUrl: string | undefined;
  /** The card holds a call that runs again once the app is reconnected. */
  retry: boolean;
}

/** Where a card stands: waiting on the person, left for later, answered, dismissed, or closed. */
export type SpadeQuestionStanding = "waiting" | "deferred" | "answered" | "dismissed" | "closed";

/** An answer as Spade takes and stores it, per kind. */
export type SpadeAnswer = string | readonly string[] | boolean | number;

const optional = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);
const label = z.string().trim().min(1);
const option = z.union([
  label.transform((text) => ({ label: text, detail: undefined })),
  z.object({ label, detail: optional(z.string()) }).transform((value) => ({
    label: value.label,
    detail: value.detail || undefined,
  })),
]);
const options = z
  .array(z.unknown())
  .catch([])
  .transform((list) =>
    list.flatMap((item) => {
      const parsed = option.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const finite = optional(z.number().finite());
const questionShape = z.object({
  id: optional(z.string()),
  prompt: z.string(),
  kind: z.string().catch("text"),
  placeholder: optional(z.string()),
  options: options.optional(),
  other: optional(z.boolean()),
  min: finite,
  max: finite,
  unit: optional(z.string()),
  time: optional(z.boolean()),
});

const connectShape = z.object({
  app: z.string().min(1),
  name: z.string().min(1),
  // A way this client doesn't know reads as one it can't offer: nothing to press but Not now.
  way: z.enum(["sign_in", "key", "later", "use", "reconnect"]).catch("later"),
  can: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((list) => list.filter((each): each is string => typeof each === "string")),
  connector: optional(z.string()),
  key_url: optional(z.string().regex(/^https:\/\//i)),
  retry: optional(z.boolean()),
});

function readConnect(raw: unknown): SpadeConnectAsk | undefined {
  const parsed = connectShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    app: value.app,
    name: value.name,
    way: value.way,
    can: value.can,
    connector: value.connector || undefined,
    keyUrl: value.key_url || undefined,
    retry: !!value.retry,
  };
}

/** One question; a kind this client doesn't know is asked as text, which Spade then checks. */
function readQuestion(raw: unknown): SpadeQuestion | undefined {
  const parsed = questionShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const base = { id: value.id || undefined, prompt: value.prompt };
  const listed = value.options ?? [];
  switch (value.kind) {
    case "choice":
      if (listed.length) return { ...base, kind: "choice", options: listed, other: !!value.other };
      break;
    case "choices":
      if (listed.length)
        return {
          ...base,
          kind: "choices",
          options: listed,
          min: value.min ?? 1,
          max: value.max ?? undefined,
          other: !!value.other,
        };
      break;
    case "confirm":
      return { ...base, kind: "confirm" };
    case "number":
      return {
        ...base,
        kind: "number",
        min: value.min ?? undefined,
        max: value.max ?? undefined,
        unit: value.unit || undefined,
      };
    case "date":
      return { ...base, kind: "date", time: !!value.time };
    case "connect": {
      const connect = readConnect(raw);
      if (connect) return { ...base, kind: "connect", connect };
      break;
    }
  }
  return { ...base, kind: "text", placeholder: value.placeholder || undefined };
}

/**
 * A card's questions from `question_asked`: its `questions`, or, from a Spade before kinds (or a
 * list this client can't read any of), one text question of its `question` words.
 */
export function spadeCardQuestions(questions: unknown, words: string): SpadeQuestion[] {
  const read = Array.isArray(questions)
    ? questions.flatMap((raw) => {
        const parsed = readQuestion(raw);
        return parsed ? [parsed] : [];
      })
    : [];
  if (read.length) return read;
  return [{ id: undefined, prompt: words, kind: "text", placeholder: undefined }];
}

/** An answer in the person's words: a label, the labels, Yes or No, the number with its unit. */
export function spadeAnswerWords(question: SpadeQuestion, answer: unknown): string {
  if (question.kind === "connect") return spadeConnectedWords(question.connect, answer);
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (typeof answer === "number")
    return question.kind === "number" && question.unit ? `${answer} ${question.unit}` : `${answer}`;
  if (Array.isArray(answer))
    return answer.filter((item): item is string => typeof item === "string").join(", ");
  return typeof answer === "string" ? answer : "";
}

/** What the person has put in a question so far. */
export type SpadeDraft =
  | { kind: "text"; text: string }
  /** `choice` and `choices`: the options picked, and own words when `other` is used. */
  | { kind: "picks"; picked: readonly string[]; other: string }
  | { kind: "confirm"; value: boolean | undefined }
  /** `number` and `date`: the field's text. */
  | { kind: "field"; text: string };

export function spadeEmptyDraft(question: SpadeQuestion): SpadeDraft {
  switch (question.kind) {
    case "text":
      return { kind: "text", text: "" };
    case "choice":
    case "choices":
      return { kind: "picks", picked: [], other: "" };
    case "confirm":
      return { kind: "confirm", value: undefined };
    case "number":
    case "date":
      return { kind: "field", text: "" };
    case "connect":
      return { kind: "text", text: "" };
  }
}

/** "2 of 3": how many a `choices` question has picked, out of the most it takes. */
export function spadePickCount(
  question: Extract<SpadeQuestion, { kind: "choices" }>,
  draft: SpadeDraft,
): string {
  const picks = draft.kind === "picks" ? draft.picked.length + (draft.other.trim() ? 1 : 0) : 0;
  const most = question.max ?? question.options.length + (question.other ? 1 : 0);
  return `${picks} of ${most}`;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * A draft as Spade would take it, or why not yet, in a few words ("Pick at most 2"). `answer` is
 * what the card posts for it.
 */
export function spadeDraftAnswer(
  question: SpadeQuestion,
  draft: SpadeDraft,
): { answer: SpadeAnswer } | { missing: string } {
  switch (question.kind) {
    case "text": {
      const text = draft.kind === "text" ? draft.text.trim() : "";
      return text ? { answer: text } : { missing: "Write an answer" };
    }
    case "choice": {
      if (draft.kind !== "picks") return { missing: "Pick one" };
      const own = question.other ? draft.other.trim() : "";
      const picked = draft.picked[0];
      if (own) return { answer: own };
      return picked ? { answer: picked } : { missing: "Pick one" };
    }
    case "choices": {
      if (draft.kind !== "picks") return { missing: `Pick at least ${question.min}` };
      const own = question.other ? draft.other.trim() : "";
      // In option order, as Spade stores them; own words last.
      const labels = question.options
        .map((each) => each.label)
        .filter((each) => draft.picked.includes(each));
      const all = own ? [...labels, own] : labels;
      if (all.length < question.min) return { missing: `Pick at least ${question.min}` };
      if (question.max !== undefined && all.length > question.max)
        return { missing: `Pick at most ${question.max}` };
      return { answer: all };
    }
    case "confirm":
      return draft.kind === "confirm" && draft.value !== undefined
        ? { answer: draft.value }
        : { missing: "Answer yes or no" };
    case "number": {
      const text = draft.kind === "field" ? draft.text.trim() : "";
      const value = Number(text);
      if (!text || !Number.isFinite(value)) return { missing: "Enter a number" };
      if (question.min !== undefined && value < question.min)
        return { missing: `At least ${question.min}` };
      if (question.max !== undefined && value > question.max)
        return { missing: `At most ${question.max}` };
      return { answer: value };
    }
    case "date": {
      const text = draft.kind === "field" ? draft.text.trim() : "";
      const fits = question.time ? dateTimePattern.test(text) : datePattern.test(text);
      return fits
        ? { answer: text }
        : { missing: question.time ? "Pick a date and time" : "Pick a date" };
    }
    // Only connecting answers it.
    case "connect":
      return { missing: `Connect ${question.connect.name}` };
  }
}

/**
 * The quiet line a connect card settles to once the person connected the app: "Connected as
 * ada@example.com", or "Reconnected" for an app that came back.
 */
export function spadeConnectedWords(ask: SpadeConnectAsk, answer: unknown): string {
  const account =
    typeof answer === "object" && answer !== null && "account" in answer
      ? (answer as { account?: unknown }).account
      : undefined;
  const verb = ask.way === "reconnect" ? "Reconnected" : "Connected";
  return typeof account === "string" && account ? `${verb} as ${account}` : `${verb} ${ask.name}`;
}

/** A connect card's one action, in words, or undefined when there is nothing to press. */
export function spadeConnectAction(ask: SpadeConnectAsk): string | undefined {
  switch (ask.way) {
    case "sign_in":
      return `Connect ${ask.name}`;
    case "key":
      return "Add a key";
    case "use":
      return `Use ${ask.name}`;
    case "reconnect":
      return `Reconnect ${ask.name}`;
    case "later":
      return undefined;
  }
}

/** The connect card in a connect card's questions, if it is one. */
export function spadeConnectOf(questions: readonly SpadeQuestion[]): SpadeConnectAsk | undefined {
  const [only, ...rest] = questions;
  return only?.kind === "connect" && rest.length === 0 ? only.connect : undefined;
}

/** The card's answers, one per question in order, or the first question still missing one. */
export function spadeCardAnswers(
  questions: readonly SpadeQuestion[],
  drafts: readonly SpadeDraft[],
): { answers: SpadeAnswer[] } | { missing: string; at: number } {
  const answers: SpadeAnswer[] = [];
  for (const [at, each] of questions.entries()) {
    const read = spadeDraftAnswer(each, drafts[at] ?? spadeEmptyDraft(each));
    if ("missing" in read) return { missing: read.missing, at };
    answers.push(read.answer);
  }
  return { answers };
}

/**
 * The question a refusal from Spade names ("Question 2: pick 1 to 2; this picks 3."), by its
 * place in the card, so the card can turn to it; undefined when it names none on the card.
 */
export function spadeRefusedQuestion(refusal: string, count: number): number | undefined {
  const named = /^Question (\d+):/.exec(refusal.trim());
  const at = named ? Number(named[1]) - 1 : -1;
  return at >= 0 && at < count ? at : undefined;
}

/** "1 question for later", "3 questions for later". */
export function spadeForLaterWords(count: number): string {
  return `${count} ${count === 1 ? "question" : "questions"} for later`;
}

/** How a settled card ended, for the quiet line under its questions. */
export function spadeCardSettledWords(card: {
  standing: SpadeQuestionStanding;
  answers: readonly unknown[] | undefined;
  typed: boolean;
}): string {
  switch (card.standing) {
    case "answered":
      return card.typed && card.answers === undefined ? "Answered in the chat" : "Answered";
    case "dismissed":
      return "Dismissed";
    default:
      return "Not answered";
  }
}
