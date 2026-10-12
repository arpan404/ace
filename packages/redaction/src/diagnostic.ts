import { createRedactor, type RedactionContext } from "./index.ts";
import { redactEmbeddedText } from "./embedded-text.ts";

/** Diagnostics may embed JSON in prose. Recursive budgets also cover JSON
 * nested inside string values. Literal streaming text keeps its existing rules. */
export function createDiagnosticRedactor(ctx: RedactionContext): (text: string) => string {
  try {
    const structured = createRedactor(ctx, [], redactEmbeddedText);
    return (text) => {
      if (text.length > 65536) return "<OVERSIZED REDACTED>";
      try {
        return structured(text);
      } catch {
        return "<REDACTION FAILED: TEXT OMITTED>";
      }
    };
  } catch {
    return () => "<REDACTION FAILED: TEXT OMITTED>";
  }
}
