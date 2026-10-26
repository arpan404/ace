import type { Interaction, InteractionResolution, Question } from "@ace/protocol";
import { answeredQuestions } from "./answered-questions.ts";

/*
 * A question's one line where the agent asked it, shared by the web and native transcripts:
 * "Codex is asking · Tabs or spaces?" while it waits, "Codex asked · Tabs or spaces? → Tabs"
 * once answered, with how it closed when it got no answer to show. Pure.
 */

/** How a closed (or locally answered) question ended, for its line and its card. */
export type AnsweredMeta =
  | { kind: "answered"; by: "you" | "elsewhere" | "unknown"; at: number | undefined }
  | { kind: "sending" }
  | { kind: "skipped" | "expired" | "cancelled" }
  | { kind: "earlier"; at: number | undefined };

/** How a question the daemon closed ended; `answeredHere` when this device sent the answer. */
export function closedMeta(
  interaction: Pick<Interaction, "state" | "resolution" | "resolvedBy" | "closedAt">,
  answeredHere: boolean,
): AnsweredMeta {
  const resolution = interaction.resolution;
  if (resolution?.kind === "question" && resolution.dismissed) return { kind: "skipped" };
  if (resolution || interaction.state === "resolved")
    return {
      kind: "answered",
      by: answeredHere ? "you" : interaction.resolvedBy ? "elsewhere" : "unknown",
      at: interaction.closedAt,
    };
  if (interaction.state === "expired") return { kind: "expired" };
  return { kind: "cancelled" };
}

/** The answer a question got, in a few words: the options picked and anything typed. */
export function answerWords(
  questions: readonly Question[],
  resolution: InteractionResolution,
): string {
  const answers = resolution.kind === "question" ? resolution.answers : {};
  return answeredQuestions(questions, answers)
    .map((row) => [...row.chosen.map((option) => option.label), ...row.typed].join(", "))
    .filter(Boolean)
    .join("; ");
}

/** How a closed question's line ends when it got no answer to show. */
export function outcomeWords(
  meta: AnsweredMeta,
  resolution: InteractionResolution | undefined,
): string | undefined {
  switch (meta.kind) {
    case "skipped": {
      const note = resolution?.kind === "question" ? resolution.feedback?.trim() : undefined;
      return note ? `Skipped · “${note}”` : "Skipped";
    }
    case "expired":
      return "Expired before an answer";
    case "cancelled":
      return "Withdrawn by the agent";
    case "sending":
      return "Sending…";
    default:
      return undefined;
  }
}

/** A closed question's line after "asked · title": its answer and how it ended. */
export function closedQuestionWords(
  questions: readonly Question[],
  resolution: InteractionResolution | undefined,
  meta: AnsweredMeta,
): { answer: string; outcome: string | undefined } {
  return {
    answer: resolution && meta.kind !== "skipped" ? answerWords(questions, resolution) : "",
    outcome: outcomeWords(meta, resolution),
  };
}
