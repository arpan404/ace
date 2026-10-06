/** At most this many distinct reasons are named; the rest are counted. */
const shownReasons = 3;
const reasonLength = 160;

const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, reasonLength);

/**
 * Sessions that wouldn't stop during a shutdown, as one error a person can read: how many of
 * `total` failed and why, e.g. "1 of 3 app sessions didn't stop: helper timed out". The
 * individual errors stay on the AggregateError for logs.
 */
export function shutdownFailure(errors: readonly unknown[], total: number): AggregateError {
  const reasons = [...new Set(errors.map(reasonOf))];
  const named = reasons.slice(0, shownReasons).join("; ");
  const more = reasons.length > shownReasons ? ` (and ${reasons.length - shownReasons} more)` : "";
  const sessions = total === 1 ? "app session" : "app sessions";
  return new AggregateError(
    errors,
    `${errors.length} of ${Math.max(total, errors.length)} ${sessions} didn't stop: ${named}${more}`,
  );
}
