import { z } from "zod";
import type { CommandRequest } from "./command.ts";
import { ForgeError } from "./errors.ts";

/** CLI reads (including GraphQL queries) must not be mistaken for remote writes. */
export function isForgeMutation(request: CommandRequest): boolean {
  if (request.args[0] === "pr" && request.args[1] === "merge") return true;
  if (request.args[0] !== "api") return false;
  const index = request.args.indexOf("--method");
  const method = index < 0 ? (request.input === undefined ? "GET" : "POST") : request.args[index + 1];
  if (method === "GET" || method === "HEAD") return false;
  if (request.args[1] === "graphql") {
    try {
      const query = z.object({ query: z.string() }).parse(JSON.parse(request.input ?? "")).query;
      if (/^\s*(?:query\b|\{)/.test(query)) return false;
    } catch { /* An unrecognized request cannot be admitted as a read. */ }
  }
  return true;
}

/** The remote accepted a write, but its result cannot be published under the current identity. */
export class ForgeMutationOutcome extends ForgeError {
  readonly receipt: unknown;
  constructor(receipt: unknown) {
    super("outcome_uncertain");
    this.receipt = receipt;
  }
}
