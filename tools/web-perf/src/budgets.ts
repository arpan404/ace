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
    /**
     * Shell plus the heaviest route: what a first screen actually loads. ADR 0045's 200 KB
     * target is for this number.
     */
    firstScreenKb: 999,
    /** A worker (client, markdown, diff) loads off the critical path but is still capped. */
    workerKb: 70,
    /** A worker with the chunks it loads later, so splitting a worker never hides bytes. */
    workerTotalKb: 999,
  },
  soak: {
    /** Events in the accelerated month-long run: 30 days at one event every 0.86 s. */
    events: 3_000_000,
    /** Retained heap growth from warm-up to the end, after full GCs. */
    growthMb: 12,
  },
  memory: {
    /** Minutes of streaming in the memory run (MEMORY_MINUTES overrides). */
    minutes: 2,
    /** From navigation until the transcript shows and the composer is there. */
    readyMs: 5_000,
    /** DOM nodes, live and detached, at any point: the transcript is virtualized. */
    domNodes: 20_000,
    /** Retained page heap growth while streaming, or while paging back through history. */
    pageGrowthMb: 10,
    /** Retained client worker heap growth while streaming. */
    workerGrowthMb: 10,
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
