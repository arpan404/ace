import { spadeProblem } from "./wire.ts";

/** Spade refused, or the daemon couldn't reach it. `status` is Spade's, when it answered. */
export class SpadeRequestError extends Error {
  readonly status: number | undefined;
  /** The daemon's code when it, not Spade, answered (`failed`: no answer came back). */
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SpadeRequestError";
    this.status = status;
    this.code = code;
  }
  /** The request may have reached Spade: no answer came back to say either way. */
  get unanswered(): boolean {
    return this.code === "failed";
  }
}

/** What a refusal says to the person, by Spade's status where its own words would be vague. */
export function spadeRefusal(status: number, body: string): string {
  if (status === 402) return "Today's spending cap is reached. Spade will answer again tomorrow.";
  return spadeProblem(body) ?? `Spade answered ${status}.`;
}

/** A Stop refused with 404 found nothing answering by the time it arrived: what Stop wanted. */
export function spadeStopAnswered(error: unknown): boolean {
  return error instanceof SpadeRequestError && error.status === 404;
}
