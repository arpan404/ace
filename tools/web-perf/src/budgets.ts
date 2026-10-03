/*
 * Web performance budgets (ADR 0056). `bun run check:perf` fails when one is exceeded. Change a
 * number only with a reason in the ADR. Each is a ratchet at the size measured on 2026-10-03
 * plus a little headroom.
 */
export const budgets = {
  bundle: {
    /** The entry and its static imports, gzip: what loads before any route. 262 KB measured. */
    initialKb: 270,
    /**
     * Shell plus the heaviest route: what a first screen actually loads (ADR 0045's 200 KB
     * target is for this number; 396 KB measured).
     */
    firstScreenKb: 405,
    /** Any lazily loaded route, the chunks it adds beyond the initial ones, gzip. 134 KB. */
    routeKb: 138,
    /** CSS, gzip. 20.2 KB. */
    cssKb: 21,
    /** A worker's eager script (client 56, markdown 33, diff 24 KB). */
    workerKb: 60,
    /** A worker with the chunks it loads later, so splitting a worker never hides bytes. 69 KB. */
    workerTotalKb: 73,
  },
  soak: {
    /** Events in the accelerated month-long run: 30 days at one event every 0.86 s. */
    events: 3_000_000,
    /** Retained heap growth from warm-up to the end, after full GCs (−3 MB measured). */
    growthMb: 6,
  },
  memory: {
    /** Minutes of streaming in the memory run (MEMORY_MINUTES overrides). */
    minutes: 2,
    /** From navigation until the transcript shows and the composer is there. 1.4 s measured. */
    readyMs: 3_000,
    /** DOM nodes, live and detached, at any point: the transcript is virtualized. 840 peak. */
    domNodes: 1_500,
    /**
     * Retained page heap growth while streaming at 5,000 events/s, or while paging back through
     * a million items. 0.8 MB over 5 minutes measured.
     */
    pageGrowthMb: 4,
    /** Retained client worker heap growth while streaming. 0.4 MB over 5 minutes measured. */
    workerGrowthMb: 3,
  },
  browser: {
    /** Fake-daemon events per second streamed while interacting. */
    eventsPerSecond: 5_000,
    /** 95th percentile of input-to-next-paint over the run (runner dependent; 40 ms measured). */
    interactionP95Ms: 100,
    /** No single main-thread task longer than this. */
    longestTaskMs: 200,
    /** Share of the run the main thread spends in long tasks (over 50 ms). */
    longTaskShare: 0.1,
  },
} as const;
