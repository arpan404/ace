import type { ContextResult } from "@ace/protocol";

/*
 * The daemon's context service (`context.request`: uploads, attachments, draft scopes) in plain
 * words, on every client. A refusal names what the person can do next; a code without a phrase
 * keeps the daemon's own message.
 */

type Result = ContextResult["result"];
type ContextFailure = Extract<Result, { kind: "error" }>;

const phrases: Partial<Record<ContextFailure["code"], string>> = {
  busy: "Files are still in use. Wait for current work to finish, then try again.",
  invalid_image: "That image can't be read.",
  forbidden: "This device may not add files to the thread.",
  not_found: "This thread or attachment is no longer available.",
  quota:
    "Attachment limit reached. Open Attachments from the thread menu and remove files you no longer need.",
  unsupported: "This attachment operation is unavailable. Update ace and try again.",
  invalid_request: "Couldn't manage the attachment. Try again.",
};

/** A context refusal as the person reads it. */
export function contextErrorMessage(failure: Pick<ContextFailure, "code" | "message">): string {
  return phrases[failure.code] ?? failure.message;
}

/** A context request that failed, worded for the person. */
export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

const isKind = <K extends Result["kind"]>(
  result: Result,
  kind: K,
): result is Extract<Result, { kind: K }> => result.kind === kind;

/** The result of the kind asked for, or a `ContextError` in plain words. */
export function expectContext<K extends Result["kind"]>(
  result: Result,
  kind: K,
): Extract<Result, { kind: K }> {
  if (result.kind === "error") throw new ContextError(contextErrorMessage(result));
  if (!isKind(result, kind)) throw new ContextError("ace answered something unexpected.");
  return result;
}
