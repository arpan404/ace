/*
 * What a failed checkout read or change says, for every client's Files tool: the daemon's file
 * error codes (and the SDK's request failures) as one plain sentence each, with the code kept
 * for decisions such as offering Replace after a CONFLICT. Pure.
 */

/** A failure said as a sentence, with the daemon's code kept for retry decisions. */
export class CheckoutError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}

const sentences: Record<string, string> = {
  NOT_FOUND: "This file isn't in the checkout any more.",
  FORBIDDEN: "This device doesn't have access to these files.",
  OUTSIDE_WORKSPACE: "That path is outside the thread's checkout.",
  BUSY: "The thread's worktree is busy (being prepared or moved). Try again in a moment.",
  CONFLICT: "This path changed or already exists. Refresh and try again.",
  INVALID_PATH: "Use a path inside the checkout, without parent folders (..).",
  EXPIRED: "This recovery item expired. Restore from Git or a backup.",
  IO_ERROR: "Couldn't change the file. Check the path and folder permissions, then try again.",
  LIMIT_EXCEEDED: "This folder has too many entries. Choose a smaller folder.",
  QUOTA: "The file transfer or recovery limit was reached. Try again later.",
  UNSUPPORTED: "ace on this machine can't serve files for the thread.",
  offline: "ace is offline. Files load again once it reconnects.",
  timeout: "ace didn't answer in time.",
  forbidden: "This device may not search the thread's checkout.",
  not_found: "The thread's checkout wasn't found.",
  unsupported: "ace on this machine can't search the thread's checkout.",
};

/** A daemon error code as a `CheckoutError`. */
export function fromCode(code: string): CheckoutError {
  return new CheckoutError(code, sentences[code] ?? "ace couldn't read the checkout.");
}

/** Turn whatever a request threw into a `CheckoutError` a view can show. */
export function checkoutError(error: unknown): CheckoutError {
  if (error instanceof CheckoutError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new CheckoutError("aborted", "Stopped.");
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code === "daemon"
        ? error.message
        : error.code
      : "failed";
  return fromCode(code);
}
