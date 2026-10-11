/** Only provider evidence about the native conversation justifies unavailable-history guidance. */
export function unavailableNativeHistory(failure: { code: string; detail: string }): boolean {
  return (
    [
      "resume_unavailable",
      "resume_unsupported",
      "session_not_found",
      "thread_not_found",
      "conversation_not_found",
    ].includes(failure.code) ||
    (failure.code === "session_open_failed" && /^No conversation found\b/i.test(failure.detail))
  );
}
