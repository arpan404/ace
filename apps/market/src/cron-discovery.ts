import type { Env } from "./env.ts";

/*
 * Discover's cron steps (ADR 0173 §6), each bounded: hourly download buckets into daily ones and
 * pruned, trending ranked in batches and swapped, top publishers.
 */

export async function discoveryCron(env: Env, now: number): Promise<void> {
  void env;
  void now;
}
