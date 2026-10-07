import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

const scrub = createDiagnosticRedactor({});
function short(value: string): string {
  const safe = scrub(value);
  // Omit whole values so a later environment redactor never receives half a secret.
  if (safe.length > 512) return "<OVERSIZED ERROR MESSAGE OMITTED>";
  if (/[\r\n]/.test(safe)) return "<MULTILINE ERROR MESSAGE OMITTED>";
  return safe;
}
export function ownData(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
/** Fixed own fields only: never enumerate, invoke accessors, or retain stack/cause/stderr. */
export function errorSummary(error: unknown): { message: string; code?: string; name?: string } {
  const field = (key: string): unknown => {
    if (!error || typeof error !== "object") return undefined;
    return ownData(error, key);
  };
  try {
    const message = field("message");
    const code = field("code");
    return {
      message:
        typeof message === "string"
          ? short(message)
          : typeof error === "string"
            ? short(error)
            : "Error detail unavailable",
      ...(typeof code === "string" || typeof code === "number"
        ? { code: short(String(code)) }
        : {}),
      ...(error instanceof Error ? { name: "Error" } : {}),
    };
  } catch {
    return { message: "Error detail unavailable" };
  }
}
