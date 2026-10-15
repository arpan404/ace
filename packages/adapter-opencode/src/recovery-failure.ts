const transportCodes = /^(?:ECONN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR)/;
/**
 * True when a failure came from reaching OpenCode rather than from what it answered: an aborted
 * or expired request, or a refused, reset or dropped connection. A later pass can outlive these.
 */
export function transientFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 12 && current instanceof Error; depth++) {
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    if (current instanceof TypeError && /fetch failed|network|terminated/i.test(current.message))
      return true;
    const code = "code" in current ? current.code : undefined;
    if (code === "unreachable" || (typeof code === "string" && transportCodes.test(code)))
      return true;
    current = current.cause;
  }
  return false;
}
