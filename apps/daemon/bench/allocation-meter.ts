/**
 * The bytes a daemon allocated over a measured window, read from JSC's own GC log
 * (`BUN_JSC_logGC=1`). Each collection's START line carries `ca=<kb>`, the bytes allocated since
 * the previous collection, which is what drives collection frequency. Bun's `heapUsed` is not a
 * usable substitute: it misses most short-lived garbage (strings above all).
 *
 * The bench entry brackets a window with a forced full collection on each side, writing a marker
 * line before and after the closing one. Every collection after `start` up to and including the
 * closing one belongs to the window; the closing one's `ca` is the remainder since the last
 * automatic collection. Heaps are told apart by the address JSC prints: the forced collections
 * run on the main isolate, any other address is a worker. A worker collection whose line a marker
 * splits before its `ca` is missed, so worker figures are a floor.
 */
export const allocationMarkers = {
  start: "ace-alloc-start",
  stop: "ace-alloc-stop",
  end: "ace-alloc-end",
} as const;

const Collection = /\[GC<(0x[0-9a-f]+)>: START [^\n]*?ca=([\d.]+)kb/g;

export interface WindowAllocation {
  /** Bytes the main isolate allocated in the window. */
  mainBytes: number;
  /** Bytes every worker isolate allocated in the window, together. */
  workerBytes: number;
  /** Automatic main-isolate collections in the window (the closing forced one excluded). */
  mainCollections: number;
}

/**
 * Reads one window out of the daemon's stderr, from just before the window's opening collection;
 * undefined until its end marker arrived. Markers are found by position, not by line: a worker's
 * GC line is written in parts and a marker from the main thread can land inside one.
 */
export function windowAllocation(log: string): WindowAllocation | undefined {
  const start = log.indexOf(allocationMarkers.start);
  const stop = start < 0 ? -1 : log.indexOf(allocationMarkers.stop, start);
  const end = stop < 0 ? -1 : log.indexOf(allocationMarkers.end, stop);
  if (end < 0) return undefined;
  const all = [...log.slice(0, end).matchAll(Collection)].map((match) => ({
    at: match.index,
    heap: match[1],
    bytes: Number(match[2]) * 1024,
  }));
  // The main isolate is the heap of the forced collections on both sides: logged after `stop`
  // and as the last before `start` (the log handed in begins with the opening collection).
  const closing = new Set(all.filter((entry) => entry.at > stop).map((entry) => entry.heap));
  const main = all.findLast((entry) => entry.at < start && closing.has(entry.heap))?.heap;
  if (!main)
    throw new Error("The window's forced collections were not logged; set BUN_JSC_logGC=1");
  const collections = all.filter((entry) => entry.at > start);
  let mainBytes = 0;
  let workerBytes = 0;
  let mainCollections = 0;
  for (const collection of collections) {
    if (collection.heap !== main) workerBytes += collection.bytes;
    else {
      mainBytes += collection.bytes;
      if (collection.at < stop) mainCollections++;
    }
  }
  return { mainBytes, workerBytes, mainCollections };
}

/** Peak main-isolate heapUsed and process CPU over a window, sampled every 10 ms. */
export function windowSampler(read: () => number, cpu: () => { user: number; system: number }) {
  let active = false;
  let peak = 0;
  let started = { user: 0, system: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;
  const sample = () => {
    if (active) peak = Math.max(peak, read());
  };
  return {
    sample,
    start() {
      active = true;
      peak = read();
      started = cpu();
      timer = setInterval(sample, 10);
    },
    stop() {
      sample();
      active = false;
      clearInterval(timer);
      const ended = cpu();
      return {
        peakHeapUsed: peak,
        cpuUserUs: ended.user - started.user,
        cpuSystemUs: ended.system - started.system,
      };
    },
  };
}
