/** What a host's hook answers: whom the call runs as, and how to let go of what it holds. */
interface Act {
  readonly settled?: () => void;
}
export type ActOutcome<T extends Act> =
  | { kind: "act"; act: T | undefined }
  | { kind: "stopped"; code: "cancelled" | "tool_timeout" };

/**
 * Who a call runs as (`CallActor`'s answer), unless the call is given up first: its `signal`
 * aborts (the client left, the session ended, the host stopped it) or the tool's `timeoutMs`
 * passes. A call given up holds no slot while a host's hook hangs; an act that arrives after is
 * told it settled, so what the host holds for it is let go.
 */
export async function actWithin<T extends Act>(
  pending: T | undefined | Promise<T | undefined>,
  signal: AbortSignal,
  timeoutMs: number,
  scheduler: { after(ms: number, run: () => void): () => void },
): Promise<ActOutcome<T>> {
  if (!(pending instanceof Promise)) return { kind: "act", act: pending };
  const given = Promise.withResolvers<ActOutcome<T>>();
  const giveUp = (code: "cancelled" | "tool_timeout") => given.resolve({ kind: "stopped", code });
  const abort = () => giveUp("cancelled");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const cancelTimer = scheduler.after(timeoutMs, () => giveUp("tool_timeout"));
  const answered = pending.then((act): ActOutcome<T> => ({ kind: "act", act }));
  try {
    const outcome = await Promise.race([answered, given.promise]);
    if (outcome.kind === "stopped")
      // Too late for this call: whatever it acts as is let go once it comes, and a refusal
      // that comes instead is no one's.
      void answered.then(
        (late) => (late.kind === "act" ? late.act?.settled?.() : undefined),
        () => {},
      );
    return outcome;
  } finally {
    cancelTimer();
    signal.removeEventListener("abort", abort);
  }
}
