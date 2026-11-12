import { ClientError } from "@ace/client";
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

/** What a refusal says to the person: Spade's own words, else by its status. */
export function spadeRefusal(status: number, body: string): string {
  // A cap's refusal says which cap and until when, in Spade's own words (ADR 0135).
  const words = spadeProblem(body);
  if (status === 402)
    return words ?? "Today's spending cap is reached. Spade will answer again tomorrow.";
  return words ?? `Spade answered ${status}.`;
}

/** A Stop refused with 404 found nothing answering by the time it arrived: what Stop wanted. */
export function spadeStopAnswered(error: unknown): boolean {
  return error instanceof SpadeRequestError && error.status === 404;
}

/**
 * No answer says whether Spade has the request: the daemon sent it and heard nothing back, or the
 * connection dropped or timed out with it out. Only Spade's own copy can settle it then.
 */
export function spadeUnanswered(error: unknown): boolean {
  if (error instanceof SpadeRequestError) return error.unanswered;
  return error instanceof ClientError && (error.code === "offline" || error.code === "timeout");
}
