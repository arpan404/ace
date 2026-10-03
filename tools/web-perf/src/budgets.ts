/*
 * Web performance budgets (ADR 0056). `bun run check:perf` fails when one is exceeded. Change a
 * number only with a reason in the ADR.
 */
export const budgets = {
  bundle: {
    /**
     * Shell, router, first route, gzip. A ratchet at today's size (ADR 0056): the ADR 0045
     * target is 200 KB and needs the shell's view chrome split by route.
     */
    initialKb: 345,
    /** Any lazily loaded route, the chunks it adds beyond the initial ones, gzip. */
    routeKb: 140,
    /** CSS, gzip. */
    cssKb: 22,
    /** A worker (client, markdown, diff) loads off the critical path but is still capped. */
    workerKb: 70,
  },
  soak: {
    /** Events in the accelerated month-long run: 30 days at one event every 0.86 s. */
    events: 3_000_000,
    /** Retained heap growth from warm-up to the end, after full GCs. */
    growthMb: 12,
  },
  browser: {
    /** Fake-daemon events per second streamed while interacting. */
    eventsPerSecond: 5_000,
    /** 95th percentile of input-to-next-paint over the run. */
    interactionP95Ms: 100,
    /** No single main-thread task longer than this. */
    longestTaskMs: 200,
    /** Share of the run the main thread spends in long tasks (over 50 ms). */
    longTaskShare: 0.1,
  },
} as const;
