import { spadeProblem } from "./wire.ts";

/** Spade refused, or the daemon couldn't reach it. `status` is Spade's, when it answered. */
export class SpadeRequestError extends Error {
  readonly status: number | undefined;
  /** The daemon's code when it, not Spade, answered (`failed`: no answer came back). */
  readonly code: string | undefined;
  /** What Spade said the request still needs, such as `client_id` or `ace_account`. */
  readonly needs: string | undefined;
  constructor(message: string, status?: number, code?: string, needs?: string) {
    super(message);
    this.name = "SpadeRequestError";
    this.status = status;
    this.code = code;
    this.needs = needs;
  }
  /** The request may have reached Spade: no answer came back to say either way. */
  get unanswered(): boolean {
    return this.code === "failed";
  }
}

/** What a refusal says to the person: Spade's own words, else its status. */
export function spadeRefusal(status: number, body: string): string {
  return spadeProblem(body) ?? `Spade answered ${status}.`;
}
