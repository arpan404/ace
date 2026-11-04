import type { ThreadReader, ThreadSource } from "@ace/client";
import type { CommandPayload, Interaction } from "@ace/protocol";
import { questionOptions } from "@ace/ui-core";
import { interactionRow } from "./interaction-rows.ts";
import { preview } from "./presentation.ts";
import { answerResolution } from "./thread-controls.ts";

/*
 * What a needs-you notification says and offers, read from the request pending now: the
 * request strip's sentence ("Claude Code wants to run a command") and its one line, and for a
 * single short question its options as buttons, plus Reply when the question takes the
 * person's own words. Pure over the interaction and the thread's reader.
 */

/** The most buttons a notification gets; the system shows four comfortably. */
export const actionLimit = 4;
/** Longer option labels don't fit a notification button; the question opens in ace instead. */
export const labelLimit = 24;

export interface AlertChoice {
  id: string;
  label: string;
}
export interface AlertRequest {
  kind: "approval" | "question" | "other";
  /** Who asks and what for, the request strip's sentence. */
  sentence: string;
  /** One line under it: the command (when `code`) or the question. */
  detail: string;
  code: boolean;
  /** The question these choices and Reply answer; null for anything else. */
  questionId: string | null;
  /** Options offered as buttons, in the agent's order; empty when they don't fit. */
  choices: AlertChoice[];
  /** The person's own words answer it. */
  reply: boolean;
}

const oneLine = (text: string) => preview(text.split("\n", 1)[0] ?? "", 200);

/** The request a notification shows for `interaction`, or undefined once it isn't pending. */
export function alertRequest(
  interaction: Interaction | undefined,
  reader: ThreadReader,
): AlertRequest | undefined {
  if (interaction?.state !== "pending") return undefined;
  const { strip } = interactionRow(interaction, reader);
  const code = strip.payload !== "";
  const base = {
    sentence: preview(strip.sentence, 200),
    detail: oneLine(code ? strip.payload : strip.detail),
    code,
    questionId: null,
    choices: [],
    reply: false,
  };
  const request = interaction.request;
  if (request.kind === "approval") return { ...base, kind: "approval" };
  if (request.kind !== "question") return { ...base, kind: "other" };
  // Several questions at once are answered together, in ace.
  const [question] = request.questions;
  if (!question || request.questions.length > 1) return { ...base, kind: "question" };
  const options = questionOptions(question);
  const reply = question.allowOther;
  const fits =
    !question.multiSelect &&
    options.length > 0 &&
    options.length <= actionLimit - (reply ? 1 : 0) &&
    options.every((option) => option.label.length <= labelLimit);
  return {
    ...base,
    kind: "question",
    questionId: question.id,
    choices: fits ? options.map((option) => ({ id: option.id, label: option.label })) : [],
    reply,
  };
}

type Resolve = Extract<CommandPayload, { type: "interaction.resolve" }>;

/**
 * The resolution for a notification's answer: an offered option's id, or the person's words
 * where the question takes them. Undefined when the question is no longer pending, changed, or
 * doesn't take that answer, so a stale button never answers something else.
 */
export function alertAnswer(
  interaction: Interaction | undefined,
  questionId: string,
  value: string,
): Resolve["resolution"] | undefined {
  if (interaction?.request.kind !== "question" || interaction.request.questions.length !== 1)
    return undefined;
  if (interaction.request.questions[0]?.id !== questionId) return undefined;
  return answerResolution(interaction, { [questionId]: [value] }, false);
}

type Schedule = (delayMs: number, run: () => void) => () => void;

/** True once the store holds daemon-confirmed state; false on error or after `ms`. */
export function confirmedState(store: ThreadSource, schedule: Schedule, ms: number) {
  const state = () =>
    store.error ? false : store.thread && !store.syncing && !store.unconfirmed ? true : undefined;
  const now = state();
  if (now !== undefined) return Promise.resolve(now);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      stop();
      cancel();
      resolve(value);
    };
    const stop = store.observe(() => {
      const value = state();
      if (value !== undefined) finish(value);
    });
    const cancel = schedule(ms, () => finish(false));
  });
}
