import { PublicToolError, type PublicToolCode } from "@ace/mcp-server/errors";
/** The message and remedy are fixed by the shared public failure catalog. */
export class BrowserActionError extends PublicToolError {
  constructor(code: PublicToolCode, _message?: string, _hint?: string) {
    super(code);
  }
}
export function staleRef(): BrowserActionError {
  return new BrowserActionError("stale_ref");
}
