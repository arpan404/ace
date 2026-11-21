import { useSyncExternalStore } from "react";
import type { Interaction, Item, Question } from "@ace/protocol";
import {
  answerOf,
  displayCommand,
  draftAnswers,
  isAnswered,
  otherAnswer,
  type QuestionDraft,
} from "@ace/ui-core";

export const questionLimit = 8;
export const optionLimit = 32;

export type InteractionAnswerState = "pending" | "resolved" | "cancelled" | "expired";

/** Whether a card may send a resolution now. Stale, answered, view-only or in-flight sends nothing. */
export function canResolveInteraction(
  state: InteractionAnswerState | string,
  inFlight: boolean,
  canAct: boolean,
): boolean {
  return state === "pending" && !inFlight && canAct;
}

/**
 * Whether this device may answer. Unknown (absent) fails closed: the card reads view-only
 * until a real pairing/act capability wires `canAct` through. Never default this to true.
 */
export function mayAct(canAct: boolean | undefined): boolean {
  return canAct === true;
}

/** The shell step's command behind an approval, when its tool call is held. Pure. */
export function shellCommandForApproval(item: Item | undefined): string | undefined {
  if (item?.type !== "tool_call" || item.call.detail.kind !== "shell") return undefined;
  return displayCommand(item.call.detail).command;
}

/** Daemon refusals in the daemon's own words; anything else stays a plain failure. */
const refusalMessages: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
  permission_mode_requires_one_shot: "This mode allows approving one action at a time only.",
  read_only_mutation_denied: "Read only mode can't approve a change.",
};

/** A daemon refusal (`receipt.ok === false`) is final: name it, never retry it. */
export function refusalMessage(error: string | undefined, fallback: string): string {
  if (error !== undefined && refusalMessages[error] !== undefined)
    return refusalMessages[error] as string;
  return fallback;
}

export type ResolutionPhase = "sending" | "sent" | "refused";

interface ResolutionEntry {
  phase: ResolutionPhase;
  /** The daemon's refusal, while it shuts the card. */
  message?: string | undefined;
}

/**
 * Remount-safe resolution records by interaction id. A card's local `sending` flag resets when
 * the list remounts and invites a double send; this store survives it. First answer wins while
 * one is on its way, an accepted answer stays shut, and a refused one never retries.
 */
const resolutions = new Map<string, ResolutionEntry>();
const resolutionListeners = new Set<() => void>();
const rememberedResolutions = 300;

function emitResolutions(): void {
  for (const listener of resolutionListeners) listener();
}

function rememberResolution(id: string, entry: ResolutionEntry): void {
  resolutions.delete(id);
  resolutions.set(id, entry);
  while (resolutions.size > rememberedResolutions) {
    const oldest = resolutions.keys().next();
    if (oldest.done) break;
    resolutions.delete(oldest.value);
  }
  emitResolutions();
}

function subscribeResolutions(listener: () => void): () => void {
  resolutionListeners.add(listener);
  return () => {
    resolutionListeners.delete(listener);
  };
}

/** The card's lock, if any: sending, accepted, or refused. Stable across renders. */
export function resolutionEntry(id: string): ResolutionEntry | undefined {
  return resolutions.get(id);
}

/** Locked while an answer is on its way, accepted, or refused: no second send. */
export function isResolutionLocked(id: string): boolean {
  return resolutions.has(id);
}

/** An answer is on its way. A second tap while locked is dropped: first answer wins. */
export function markResolutionSending(id: string): void {
  if (resolutions.has(id)) return;
  rememberResolution(id, { phase: "sending" });
}

/** The daemon accepted the answer: the card stays shut even across a remount. */
export function markResolutionSent(id: string): void {
  rememberResolution(id, { phase: "sent" });
}

/** The daemon refused the answer: name it and stay shut instead of retrying. */
export function markResolutionRefused(id: string, message: string): void {
  rememberResolution(id, { phase: "refused", message });
}

/**
 * Transport failure: the daemon never saw the answer, so the card may try again while its
 * request is still pending. Daemon refusals never clear here.
 */
export function clearResolutionSending(id: string): void {
  if (resolutions.get(id)?.phase !== "sending") return;
  resolutions.delete(id);
  emitResolutions();
}

/**
 * A closed interaction drops its in-flight and refused locks: they belonged to the old
 * request. An accepted answer stays shut (answering it again is at best redundant).
 */
export function clearClosedResolution(id: string): void {
  if (resolutions.get(id)?.phase === "sent") return;
  if (resolutions.delete(id)) emitResolutions();
}

/** This interaction's lock, followed across remounts. */
export function useResolutionEntry(id: string): ResolutionEntry | undefined {
  return useSyncExternalStore(
    subscribeResolutions,
    () => resolutions.get(id),
    () => undefined,
  );
}

/** Clamp a pager to the visible window. Pure. */
export function currentQuestionIndex(at: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(at, 0), count - 1);
}

/** Whether the bridge caps this question set for a phone card (answer on a larger screen). */
export function isUnanswerable(questions: readonly Question[]): boolean {
  return (
    questions.length > questionLimit ||
    questions.some((question) => question.options.length > optionLimit)
  );
}

/** The questions a phone card shows (bounded, exact ids preserved). */
export function visibleQuestions(questions: readonly Question[]): Question[] {
  const shown: Question[] = [];
  for (const question of questions.slice(0, questionLimit)) {
    shown.push({ ...question, options: question.options.slice(0, optionLimit) });
  }
  return shown;
}

export function emptyQuestionDraft(): QuestionDraft {
  return { picked: {}, texts: {}, at: 0 };
}

/** Toggle one option: multi-select adds/removes, single-select replaces and clears free text. */
export function togglePick(
  draft: QuestionDraft,
  question: Pick<Question, "id" | "multiSelect">,
  optionId: string,
): QuestionDraft {
  const current = draft.picked[question.id] ?? [];
  if (question.multiSelect) {
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId];
    return { ...draft, picked: { ...draft.picked, [question.id]: next } };
  }
  return {
    ...draft,
    picked: { ...draft.picked, [question.id]: [optionId] },
    texts: { ...draft.texts, [question.id]: "" },
  };
}

/** Type free text for a question that allows its own words. */
export function setOtherText(
  draft: QuestionDraft,
  question: Pick<Question, "id" | "multiSelect">,
  text: string,
): QuestionDraft {
  const picked = draft.picked[question.id] ?? [];
  if (question.multiSelect) {
    const hasOther = picked.includes(otherAnswer);
    const next = text.trim()
      ? hasOther
        ? picked
        : [...picked, otherAnswer]
      : picked.filter((id) => id !== otherAnswer);
    return {
      ...draft,
      picked: { ...draft.picked, [question.id]: next },
      texts: { ...draft.texts, [question.id]: text },
    };
  }
  const next = text.trim() ? [] : picked.filter((id) => id !== otherAnswer);
  // Single-select free text replaces a picked option; keep the marker so validation sees words.
  const withMarker = text.trim() ? [otherAnswer] : next;
  return {
    ...draft,
    picked: { ...draft.picked, [question.id]: withMarker },
    texts: { ...draft.texts, [question.id]: text },
  };
}

/** Whether the draft answers one question (picks present, words where the free answer is). */
export function isQuestionAnswered(question: Question, draft: QuestionDraft): boolean {
  return isAnswered(question, draft);
}

/** This page may advance: the visible question has an answer. */
export function canContinue(question: Question | undefined, draft: QuestionDraft): boolean {
  return isAnswered(question, draft);
}

/**
 * Every question's answer, or undefined while any question is unanswered.
 * Free text rides as its words; picks keep exact option ids.
 */
export function completeAnswers(
  questions: readonly Question[],
  draft: QuestionDraft,
): Record<string, string[]> | undefined {
  for (const question of questions) {
    if (!isAnswered(question, draft)) return undefined;
  }
  return draftAnswers(questions, draft);
}

/** One question's answer from the draft (exact ids, free text as words). */
export function answerFor(question: Question, draft: QuestionDraft): string[] {
  return answerOf(question, draft);
}

/** The canonical question resolution the daemon validates; first answer wins there. */
export function questionResolution(
  questions: readonly Question[],
  draft: QuestionDraft,
): { kind: "question"; answers: Record<string, string[]> } | undefined {
  const answers = completeAnswers(questions, draft);
  return answers ? { kind: "question", answers } : undefined;
}

export function dismissedResolution(): {
  kind: "question";
  answers: Record<string, string[]>;
  dismissed: true;
} {
  return { kind: "question", answers: {}, dismissed: true };
}

export function approvalResolution(optionId: string): { kind: "approval"; optionId: string } {
  return { kind: "approval", optionId };
}

export function isPendingInteraction(interaction: Pick<Interaction, "state">): boolean {
  return interaction.state === "pending";
}
