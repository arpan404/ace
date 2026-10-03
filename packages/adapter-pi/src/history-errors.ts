const messages = {
  missing: "Pi saved session is missing or unreadable",
  header: "Pi saved session header is invalid or exceeds 64 KiB",
  identity: "Pi saved session identity changed",
  cancelledSwitch: "Pi extension cancelled session switch",
  cancelledFork: "Pi extension cancelled fork",
  idle: "Pi history controls require an idle session",
  entry: "Invalid Pi entry id",
  acknowledgement: "Pi navigation was not acknowledged",
  fork: "Pi fork did not create a new session",
};
export class PiHistoryError extends Error {
  constructor(code: keyof typeof messages) {
    super(messages[code]);
  }
}
/** Provider exception text can contain credentials. Only our own fixed diagnostics escape. */
export function piHistoryErrorMessage(error: unknown): string {
  return error instanceof PiHistoryError ? error.message : "Pi native history operation failed";
}
