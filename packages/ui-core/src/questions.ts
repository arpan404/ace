import type { Question } from "@ace/protocol";
import { contentHash } from "./content-hash.ts";

/** One answer to offer for a question, its "(Recommended)" suffix turned into a flag. */
export interface QuestionOption {
  id: string;
  label: string;
  description: string | undefined;
  recommended: boolean;
}

const recommendedSuffix = /\s*\(recommended\)\s*$/i;

/** Claude marks its suggested answer with "(Recommended)"; clients show it as a quiet tag. */
export function questionOptions(question: Question): QuestionOption[] {
  return question.options.map((option) => ({
    id: option.id,
    label: option.label.replace(recommendedSuffix, ""),
    description: option.description,
    recommended: recommendedSuffix.test(option.label),
  }));
}

/** One question with the answer given, as the answered card shows it (IR-1). */
export interface AnsweredQuestion {
  id: string;
  header: string | undefined;
  text: string;
  /** The options picked, in the question's order. */
  chosen: QuestionOption[];
  /** Free text typed instead of (or beside) an option. */
  typed: string[];
  /** Options not picked, behind "Show all N options". */
  others: QuestionOption[];
}

/**
 * Each question beside its answer. Answers hold option ids, or free text for "Something else";
 * an adapter that sent labels instead still matches its option.
 */
export function answeredQuestions(
  questions: readonly Question[],
  answers: Readonly<Record<string, readonly string[]>> = {},
): AnsweredQuestion[] {
  return questions.map((question) => {
    const options = questionOptions(question);
    const given = answers[question.id] ?? [];
    const picked = new Set<string>();
    const typed: string[] = [];
    for (const value of given) {
      const option =
        options.find((candidate) => candidate.id === value) ??
        options.find(
          (candidate) =>
            candidate.label.toLowerCase() ===
            value.replace(recommendedSuffix, "").trim().toLowerCase(),
        );
      if (option) picked.add(option.id);
      else if (value.trim()) typed.push(value.trim());
    }
    return {
      id: question.id,
      header: question.header,
      text: question.text,
      chosen: options.filter((option) => picked.has(option.id)),
      typed,
      others: options.filter((option) => !picked.has(option.id)),
    };
  });
}

/** The interaction parts a question's outcome reads. */
export interface QuestionInteraction {
  state: "pending" | "resolved" | "cancelled" | "expired";
  request: { kind: string; questions?: readonly Question[] };
  resolution?:
    | { kind: "question"; answers: Record<string, string[]>; dismissed?: boolean | undefined }
    | { kind: string }
    | undefined;
  closedAt?: number | undefined;
}

export type QuestionOutcome = "pending" | "answered" | "skipped" | "expired" | "cancelled";

/** Where a question stands: answered, skipped by the person, or closed without an answer. */
export function questionOutcome(interaction: QuestionInteraction): QuestionOutcome {
  const resolution = interaction.resolution;
  if (resolution?.kind === "question")
    return "dismissed" in resolution && resolution.dismissed ? "skipped" : "answered";
  if (interaction.state === "expired") return "expired";
  if (interaction.state === "cancelled") return "cancelled";
  return interaction.state === "resolved" ? "answered" : "pending";
}

/** The question's text, or "3 questions", for headers and labels. */
export function questionTitle(questions: readonly Question[]): string {
  return questions.length === 1
    ? (questions[0]?.text ?? "Question")
    : `${questions.length} questions`;
}

/** The parts of an interaction that identify the native request it stands for. */
export interface RequestParts {
  toolCallId?: string | undefined;
  request: unknown;
}

/**
 * The native request an interaction stands for (A1/A3): the provider item it was raised from
 * plus a hash of everything it asks. A provider replaying the same request (after a restart)
 * keeps both; the same wording asked again later comes from a new item, and a different
 * question from the same item differs in its hash. Without an item there is no identity:
 * wording alone never makes two requests the same.
 */
export function requestIdentity(interaction: RequestParts): string | undefined {
  if (!interaction.toolCallId) return undefined;
  return `${interaction.toolCallId}:${contentHash(JSON.stringify(interaction.request))}`;
}
