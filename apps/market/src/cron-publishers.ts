import type { Env } from "./env.ts";

/*
 * The publishers' cron steps (ADR 0173 §5, §8, §13), each bounded: scan jobs that didn't fit a
 * request, drafts untouched for 30 days, expired transfers and proof tokens, verification
 * re-checks, handle skeletons from before the migration.
 */

export async function publisherCron(
  env: Env,
  now: number,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<void> {
  void env;
  void now;
  void fetch;
}
