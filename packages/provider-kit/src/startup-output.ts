/*
 * What a provider CLI printed on stderr while its session opened. A CLI that can't start
 * usually says why there ("Failed to load extension …"), not in the error its transport
 * reports ("RPC closed"). The failure keeps a short tail of it as its technical detail, shown
 * only behind the failed message's Details; the lines themselves are not transcript rows.
 */

/** Bytes of stderr kept; the open error's whole detail is capped at 2 KiB. */
const tailBytes = 1536;

/** A bounded tail of startup stderr lines. Callers pass lines already redacted. */
export class StartupOutput {
  #tail = "";
  add(line: string): void {
    const bytes = Buffer.from(this.#tail ? `${this.#tail}\n${line}` : line);
    this.#tail = bytes.subarray(Math.max(0, bytes.length - tailBytes)).toString("utf8");
    // The cut can land inside a UTF-8 sequence; keep the encoded bound after replacement.
    while (Buffer.byteLength(this.#tail) > tailBytes) this.#tail = this.#tail.slice(1);
  }
  get text(): string {
    return this.#tail.trim();
  }
}

/**
 * The open failure with the provider's own words: `detail` is the adapter's message followed
 * by what the CLI printed, so `SessionOpenError` carries both. Code and title are kept.
 */
export function withStartupOutput(error: unknown, output: string): unknown {
  if (!output) return error;
  const fields = typeof error === "object" && error !== null ? error : {};
  const detail = Reflect.get(fields, "detail");
  const message =
    typeof detail === "string" && detail
      ? detail
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
  return {
    ...pick(fields, "code"),
    ...pick(fields, "reason"),
    ...pick(fields, "title"),
    ...pick(fields, "_tag"),
    message,
    detail: message && !output.includes(message) ? `${message}\n\n${output}` : output,
  };
}

function pick(source: object, key: string): Record<string, string> {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? { [key]: value } : {};
}
