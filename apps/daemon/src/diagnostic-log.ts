import { createLogger, type LoggerOptions } from "@ace/diagnostics";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import type { RedactionContext } from "@ace/redaction";

/** The daemon's retained output uses the same diagnostic policy as its file sink. */
export function createDaemonLogger(
  options: Omit<LoggerOptions, "redact">,
  context: RedactionContext,
) {
  return createLogger({ ...options, redact: createDiagnosticRedactor(context) });
}
