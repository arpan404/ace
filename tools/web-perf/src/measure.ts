import type { CDPSession, Page } from "@playwright/test";
import { z } from "zod";

/*
 * Main-thread measurements shared by the browser runs: long tasks and Event Timing entries from
 * first paint (an init script), summarised as input-to-next-paint per interaction.
 */

/** Init script: records long tasks and, per interaction, its longest event duration. */
export const observe = () => {
  const record = {
    longTasks: [] as number[],
    events: new Map<number, number>(),
    start: 0,
    startEvents: 0,
    startStreamedAt: 0,
  };
  const reset = () => {
    record.longTasks.length = 0;
    record.events.clear();
    record.start = performance.now();
    record.startEvents = Reflect.get(globalThis, "acePerf")?.events ?? 0;
    record.startStreamedAt = Reflect.get(globalThis, "acePerf")?.at ?? 0;
    return record.start;
  };
  Object.assign(globalThis, { acePerfRecord: Object.assign(record, { reset }) });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= record.start) record.longTasks.push(entry.duration);
    }
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < record.start) continue;
      const id =
        "interactionId" in entry && typeof entry.interactionId === "number"
          ? entry.interactionId
          : 0;
      if (!id) continue;
      record.events.set(id, Math.max(record.events.get(id) ?? 0, entry.duration));
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
};

/** Forget what was recorded so far; returns when the window starts. */
export async function resetRecord(page: Page): Promise<number> {
  return z
    .number()
    .nonnegative()
    .parse(await page.evaluate(() => Reflect.get(globalThis, "acePerfRecord").reset()));
}

export interface MainThread {
  interactions: number;
  p75: number;
  p95: number;
  longest: number;
  longShare: number;
  longCount: number;
  seconds: number;
}

/** Input-to-paint percentiles and long tasks since `start`. */
export async function readRecord(
  page: Page,
  start: number,
): Promise<MainThread & { streamedEvents: number; streamedSeconds: number }> {
  const sample = await page.evaluate((from) => {
    const record = Reflect.get(globalThis, "acePerfRecord");
    if (from !== record.start) throw new Error("Measurement window was reset before reading");
    const elapsed = (performance.now() - from) / 1000;
    const stream = Reflect.get(globalThis, "acePerf");
    const streamedEvents = (stream?.events ?? 0) - record.startEvents;
    // Counters arrive in worker batches. Pair their difference with the delivery clock,
    // not the page clock sampled between batches (which biases a fixed-rate source).
    const streamedSeconds = ((stream?.at ?? 0) - record.startStreamedAt) / 1000;
    const durations = [...record.events.values()].toSorted((a: number, b: number) => a - b);
    const at = (q: number) =>
      durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] ?? 0;
    const longTasks: number[] = record.longTasks;
    return {
      interactions: durations.length,
      p75: at(0.75),
      p95: at(0.95),
      longest: Math.max(0, ...longTasks),
      longShare: longTasks.reduce((sum, value) => sum + value, 0) / (elapsed * 1000),
      longCount: longTasks.length,
      seconds: elapsed,
      streamedEvents,
      streamedSeconds,
    };
  }, start);
  return MainThreadSample.parse(sample);
}

const MainThreadSample = z.object({
  interactions: z.number().int().nonnegative(),
  p75: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  longest: z.number().nonnegative(),
  longShare: z.number().nonnegative(),
  longCount: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  streamedEvents: z.number().int().nonnegative(),
  streamedSeconds: z.number().nonnegative(),
});

/** Measure completed delivery batches using their own monotonic timestamps. */
export function streamedRate(sample: { streamedEvents: number; streamedSeconds: number }): number {
  return sample.streamedSeconds > 0 ? sample.streamedEvents / sample.streamedSeconds : 0;
}

/** Count every attached node in one page task, including text and open shadow trees. */
const attachedNodes = () => {
  let nodes = 0;
  const roots: Node[] = [document];
  for (let root = roots.pop(); root; root = roots.pop()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    do {
      nodes++;
      const node = walker.currentNode;
      if (node instanceof Element && node.shadowRoot) roots.push(node.shadowRoot);
    } while (walker.nextNode());
  }
  return nodes;
};

export interface PageMemory {
  heapMb: number;
  nodes: number;
  chromeNodes: number;
  listeners: number;
}

/** Retained heap after collection, live DOM for budgets, Chrome's counter for diagnosis. */
export async function pageMemory(cdp: CDPSession): Promise<PageMemory> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const counters = await cdp.send("Memory.getDOMCounters");
  const live = z.object({ result: z.object({ value: z.number().int().nonnegative() }) }).parse(
    await cdp.send("Runtime.evaluate", {
      expression: `(${attachedNodes.toString()})()`,
      returnByValue: true,
    }),
  );
  return {
    heapMb: heap.usedSize / 1024 / 1024,
    nodes: live.result.value,
    chromeNodes: counters.nodes,
    listeners: counters.jsEventListeners,
  };
}

/** Both DOM gates use attached nodes; detached churn only affects the diagnostic. */
export function reportDOM(
  sample: Pick<PageMemory, "nodes" | "chromeNodes">,
  limit: number,
): boolean {
  report("Chrome DOM counter (diagnostic, includes detached)", sample.chromeNodes, "-", true);
  return report("attached DOM nodes", sample.nodes, limit, sample.nodes <= limit);
}

/** One line of a budget report; returns whether it held. */
export function report(label: string, value: number, limit: number | string, ok: boolean): boolean {
  process.stdout.write(
    `${ok ? " " : "✗"} ${label.padEnd(52)} ${value.toFixed(2).padStart(9)}  (budget ${limit})\n`,
  );
  return ok;
}
