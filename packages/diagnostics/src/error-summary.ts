function short(value: string, redact: (text: string) => string): string {
  if (value.length > 512) return "<OVERSIZED ERROR MESSAGE OMITTED>";
  if (/[\r\n]/.test(value)) return "<MULTILINE ERROR MESSAGE OMITTED>";
  // Contextual exact values must be scrubbed before embedded records normalize.
  const safe = redact(value);
  // Omit whole values so a later environment redactor never receives half a secret.
  if (safe.length > 512) return "<OVERSIZED ERROR MESSAGE OMITTED>";
  if (/[\r\n]/.test(safe)) return "<MULTILINE ERROR MESSAGE OMITTED>";
  return safe;
}
export function ownData(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
/** A data property found on the object or its prototypes; accessors are never invoked. */
function inheritedData(input: object, key: string): unknown {
  let current: object | null = input;
  for (let hops = 0; current && hops < 8; hops++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
/** The class name (`TypeError`, `SqliteError`), only when it reads as an identifier. */
function errorName(error: Error): string {
  const name = inheritedData(error, "name");
  return typeof name === "string" && /^[A-Za-z_$][\w$.]{0,63}$/.test(name) ? name : "Error";
}
const nativeStack = Object.getOwnPropertyDescriptor(new Error("probe"), "stack")?.get;
const FRAMES = 8;
/**
 * Up to eight `at …` frame lines of an Error's own engine-captured stack. The message part
 * of a stack is never kept: it can span lines that the message rules would have omitted.
 */
export function stackFrames(error: unknown, redact: (text: string) => string): string[] {
  if (!(error instanceof Error)) return [];
  const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
  let stack: unknown;
  try {
    // Only the engine's own accessor runs; a producer-defined getter is never invoked. The
    // engine formats lazily and may still reach a throwing message accessor.
    stack =
      descriptor && "value" in descriptor
        ? descriptor.value
        : nativeStack && descriptor?.get === nativeStack
          ? nativeStack.call(error)
          : undefined;
  } catch {
    return [];
  }
  if (typeof stack !== "string") return [];
  // Frames are the trailing run of `at` lines; anything above them belongs to the message.
  const lines = stack.split("\n");
  let first = lines.length;
  while (first > 0 && /^\s+at \S/.test(lines[first - 1] ?? "")) first--;
  return lines
    .slice(first, first + FRAMES)
    .map((line) => line.trim())
    .filter((line) => line.length <= 240)
    .map(redact);
}
/** Fixed own fields only: never enumerate, invoke accessors, or retain cause/stderr. */
export function errorSummary(
  error: unknown,
  redact: (text: string) => string,
): { message: string; code?: string; name?: string } {
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
          ? short(message, redact)
          : typeof error === "string"
            ? short(error, redact)
            : "Error detail unavailable",
      ...(typeof code === "string" || typeof code === "number"
        ? { code: short(String(code), redact) }
        : {}),
      ...(error instanceof Error ? { name: errorName(error) } : {}),
    };
  } catch {
    return { message: "Error detail unavailable" };
  }
}
