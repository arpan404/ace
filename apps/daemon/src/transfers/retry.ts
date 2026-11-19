/**
 * Runs `run` until it succeeds: again after 1 second, then 2, doubling up to a minute, for
 * `attempts` tries in all; then `giveUp` records a final outcome. Stops quietly when `closed`
 * says the daemon is shutting down, leaving the work to the next start (ADR 0191).
 */
export async function persist(input: {
  attempts: number;
  run(): Promise<void>;
  giveUp(error: unknown): Promise<void> | void;
  sleep(ms: number): Promise<void>;
  closed(): boolean;
  log(message: string, fields: Record<string, unknown>): void;
  label: string;
}): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < input.attempts; attempt++) {
    if (input.closed()) return;
    try {
      await input.run();
      return;
    } catch (caught) {
      error = caught;
      input.log(`${input.label} failed; trying again`, { attempt, error: String(caught) });
    }
    if (attempt + 1 < input.attempts) await input.sleep(Math.min(1_000 * 2 ** attempt, 60_000));
  }
  if (!input.closed()) await input.giveUp(error);
}
