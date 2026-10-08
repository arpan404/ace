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
    /** CSS, gzip. 19.2 KB (20.9 before Tailwind's legacy-browser polyfills were stripped). */
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
    /** Attached DOM nodes at any sample: the transcript is virtualized. */
    domNodes: 1_500,
    /**
     * Retained page heap growth while streaming at 5,000 events/s, or while paging back through
     * a million items. 0.8 MB over 5 minutes measured.
     */
    pageGrowthMb: 4,
    /** Retained client worker heap growth while streaming. 0.4 MB over 5 minutes measured. */
    workerGrowthMb: 3,
  },
  longThread: {
    /** Items of the synthetic five-day thread (`multiDayThread`, ADR 0062), in 2,000 turns. */
    items: 1_000_000,
    /** Rounds of opening, jumping, scrolling the window, searching and going back live. */
    rounds: 6,
    /** Live items per second added to the thread's last turn meanwhile. */
    liveRate: 20,
    /** From navigation until the transcript shows and the composer is there. */
    readyMs: 3_000,
    /** Input to next paint, p95, across every interaction of the rounds. */
    interactionP95Ms: 100,
    longestTaskMs: 200,
    longTaskShare: 0.1,
    /** Attached DOM nodes at any sample: windows and the timeline are virtual. */
    domNodes: 1_500,
    /** Retained page heap growth from the first round to the last. */
    pageGrowthMb: 4,
  },
  markdownStream: {
    /** Seconds of streaming measured (PERF_SECONDS overrides): one whole answer. */
    seconds: 11,
    /** Fake-daemon deltas per second, 20 characters each: 4 KB of markdown a second. */
    eventsPerSecond: 200,
    /** The answer must reach this size inside the window, or the run measured too little. */
    answerKb: 30,
    /** Input to next paint, p95, while typing as the answer streams (40–56 ms measured). */
    interactionP95Ms: 100,
    /** No long task at all: the browser reports only tasks over 50 ms. */
    longestTaskMs: 50,
    /**
     * Median markdown worker time per update in the answer's last quarter over its first: work
     * per update follows the open block, not the answer (1.0 measured; 4.7 when every update
     * lexed the whole answer).
     */
    workerGrowth: 3,
    /** Medians under one tick of the worker's clock (0.1 ms) count as one tick. */
    workerFloorMs: 0.1,
    /** The page's main-thread busy time per drawn frame (2.6 ms measured; 3.9 before). */
    mainMsPerFrame: 4,
    /**
     * Blocks whose DOM node was replaced while the answer streamed: only an open block that
     * changes kind (a header line becoming a table) is replaced (9–10 measured; 430 before).
     */
    remounts: 20,
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
