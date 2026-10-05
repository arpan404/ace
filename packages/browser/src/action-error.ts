/** A recoverable browser action failure with an agent-readable remedy. */
export class BrowserActionError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
export function staleRef(): BrowserActionError {
  return new BrowserActionError(
    "stale_ref",
    "Stale or unknown browser ref",
    "Call ace_browser_snapshot and use a ref from the current document.",
  );
}
