import { z } from "zod";
import type { CommandRequest } from "./command.ts";
import { ForgeError } from "./errors.ts";

/** CLI reads (including GraphQL queries) must not be mistaken for remote writes. */
export function isForgeMutation(request: CommandRequest): boolean {
  if (request.args[0] === "pr" && request.args[1] === "merge") return true;
  if (request.args[0] !== "api") return false;
  const index = request.args.indexOf("--method");
  const method =
    index < 0 ? (request.input === undefined ? "GET" : "POST") : request.args[index + 1];
  if (method === "GET" || method === "HEAD") return false;
  if (request.args[1] === "graphql") {
    try {
      const query = z.object({ query: z.string() }).parse(JSON.parse(request.input ?? "")).query;
      if (/^\s*(?:query\b|\{)/.test(query)) return false;
    } catch {
      /* An unrecognized request cannot be admitted as a read. */
    }
  }
  return true;
}

/**
 * How long an uncertain write fences a retry of the same write. GitHub converges in seconds;
 * after this window a complete read that still shows no trace of the write proves it did not
 * land, and the fence is released instead of blocking every later action forever.
 */
export const uncertainWriteWindowMs = 10 * 60_000;

/** True once a write reserved at `at` has outlived the uncertainty window. */
export function uncertainWriteExpired(at: number, now: number): boolean {
  return now - at >= uncertainWriteWindowMs;
}

/** The remote accepted a write, but its result cannot be published under the current identity. */
export class ForgeMutationOutcome extends ForgeError {
  readonly receipt: unknown;
  constructor(receipt: unknown) {
    super("outcome_uncertain");
    this.receipt = receipt;
  }
}

/** Certainty comes from process admission, never from the error produced by a probe. */
export class MutationDispatch {
  #dispatched = false;
  #rejected = false;
  readonly #beforeDispatch: (() => void) | undefined;
  constructor(beforeDispatch?: () => void) {
    this.#beforeDispatch = beforeDispatch;
  }
  /** Journal possible dispatch before spawning, closing the crash gap between fork and receipt. */
  prepare(): void {
    this.#beforeDispatch?.();
  }
  get dispatched(): boolean {
    return this.#dispatched;
  }
  record(): void {
    this.#dispatched = true;
  }
  get definitelyFailed(): boolean {
    return !this.#dispatched || this.#rejected;
  }
  /** Compatibility with the original observer API; admission is still recorded by the runner. */
  begin(): void {
    this.prepare();
  }
  reject(error?: unknown): void {
    if (error === undefined || (error instanceof ForgeError && error.dispatched === false))
      this.#rejected = true;
  }
  failure(error: unknown): unknown {
    return !this.#dispatched || this.#rejected || error instanceof ForgeMutationOutcome
      ? error
      : new ForgeMutationOutcome({ dispatched: true });
  }
}
