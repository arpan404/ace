import type { InteractionState } from "@ace/protocol";

/**
 * What the person is told after answering a request (ADR 0176 §9). The daemon admitting the
 * answer isn't the answer landing: the provider takes it, then the daemon closes the request.
 * So the words claim the decision only once the thread's store shows the request resolved,
 * and say plainly when it closed another way or nothing confirmed it in time. Pure.
 */
export type AnswerOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

/** How long an admitted answer may wait for the request to close before the person hears so. */
export const answerPatienceMs = 10_000;

export function answerOutcome(input: {
  /** The request's state in the thread's store; undefined while the store hasn't loaded it. */
  readonly state: InteractionState | undefined;
  readonly sentAt: number;
  readonly now: number;
  /** The words for the answer once it landed ("Allow once: Run bun install"). */
  readonly done: string;
}): AnswerOutcome {
  if (input.state === "resolved") return { kind: "done", text: input.done };
  if (input.state === "cancelled" || input.state === "expired")
    return {
      kind: "failed",
      text: "That request closed before your answer reached the agent. Nothing was answered.",
    };
  if (input.now - input.sentAt < answerPatienceMs) return { kind: "waiting" };
  return {
    kind: "failed",
    text: "ace took your answer, but the agent hasn't confirmed it, so the request is still open. Try again, or answer it in the app.",
  };
}
