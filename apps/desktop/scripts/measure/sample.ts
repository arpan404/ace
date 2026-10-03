import { app, type WebContents } from "electron";

/** One process group over a phase. */
export interface Group {
  /** Resident memory (MB). */
  mb: number;
  /** CPU time over the phase, in % of one core. */
  cpu: number;
  /** Idle wakeups per second over the phase (timers firing); always 0 on Windows. */
  wakeups: number;
  count: number;
}

export interface Sample {
  phase: string;
  /** Browser process (Electron main). */
  main: Group;
  /** The app window's renderer. */
  renderer: Group;
  /** Other renderers: embedded browser views. */
  views: Group;
  gpu: Group;
  /** Network service, storage, audio and other utility processes. */
  utility: Group;
  other: Group;
  total: Group;
  /** Main-process V8 heap in use (MB). */
  mainHeap: number;
  /** The window renderer's main-isolate V8 heap in use (MB). */
  rendererHeap: number | undefined;
}

const groups = ["main", "renderer", "views", "gpu", "utility", "other", "total"] as const;
type GroupName = (typeof groups)[number];
type Metric = ReturnType<typeof app.getAppMetrics>[number];

function inGroup(metric: Metric, name: GroupName, rendererPid: number): boolean {
  if (name === "total") return true;
  if (metric.type === "Browser") return name === "main";
  if (metric.type === "Tab")
    return metric.pid === rendererPid ? name === "renderer" : name === "views";
  if (metric.type === "GPU") return name === "gpu";
  if (metric.type === "Utility") return name === "utility";
  return name === "other";
}

let phaseStart = { at: performance.now(), cpu: new Map<number, number>() };

/** Starts a phase: CPU and wakeups reported by the next sample cover the time from here. */
export function startPhase(): void {
  const metrics = app.getAppMetrics();
  phaseStart = {
    at: performance.now(),
    cpu: new Map(metrics.map((metric) => [metric.pid, metric.cpu.cumulativeCPUUsage ?? 0])),
  };
}

async function rendererHeap(contents: WebContents | undefined): Promise<number | undefined> {
  if (!contents || contents.isDestroyed()) return undefined;
  try {
    contents.debugger.attach("1.3");
    const usage = (await contents.debugger.sendCommand("Runtime.getHeapUsage")) as {
      usedSize: number;
    };
    return usage.usedSize / 2 ** 20;
  } catch {
    return undefined;
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}

const median = (values: number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/**
 * Memory is the median of three readings a second apart (resident size jitters). CPU is the
 * CPU time used since `startPhase`; wakeups are the first reading's, which covers the phase.
 */
export async function sample(phase: string, contents: WebContents | undefined): Promise<Sample> {
  const rendererPid = contents && !contents.isDestroyed() ? contents.getOSProcessId() : -1;
  const seconds = (performance.now() - phaseStart.at) / 1_000;
  const readings: { metrics: Metric[]; heap: number }[] = [];
  for (let index = 0; index < 3; index++) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    readings.push({ metrics: app.getAppMetrics(), heap: process.memoryUsage().heapUsed });
  }
  const first = readings[0];
  const group = (name: GroupName): Group => {
    const members = (first?.metrics ?? []).filter((metric) => inGroup(metric, name, rendererPid));
    return {
      mb: median(
        readings.map(
          (reading) =>
            reading.metrics
              .filter((metric) => inGroup(metric, name, rendererPid))
              .reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024,
        ),
      ),
      cpu:
        (members.reduce(
          (sum, metric) =>
            sum + (metric.cpu.cumulativeCPUUsage ?? 0) - (phaseStart.cpu.get(metric.pid) ?? 0),
          0,
        ) /
          seconds) *
        100,
      wakeups: members.reduce((sum, metric) => sum + metric.cpu.idleWakeupsPerSecond, 0),
      count: members.length,
    };
  };
  return {
    phase,
    main: group("main"),
    renderer: group("renderer"),
    views: group("views"),
    gpu: group("gpu"),
    utility: group("utility"),
    other: group("other"),
    total: group("total"),
    mainHeap: median(readings.map((reading) => reading.heap / 2 ** 20)),
    rendererHeap: await rendererHeap(contents),
  };
}
