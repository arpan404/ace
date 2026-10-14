import { PublicToolError, type PublicToolCode } from "@ace/mcp-server/errors";
/** The message and remedy are fixed by the shared public failure catalog. */
export class BrowserActionError extends PublicToolError {
  constructor(
    code: PublicToolCode,
    _message?: string,
    _hint?: string,
    issues?: { path: string; expected: string }[],
  ) {
    super(code, undefined, undefined, undefined, undefined, issues);
  }
}
export function staleRef(): BrowserActionError {
  return new BrowserActionError("stale_ref");
}
