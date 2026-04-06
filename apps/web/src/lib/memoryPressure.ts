interface PerformanceMemoryLike {
  readonly usedJSHeapSize?: number;
  readonly jsHeapSizeLimit?: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemoryLike;
}

interface NavigatorWithDeviceMemory extends Navigator {
  readonly deviceMemory?: number;
}

export type MemoryPressureLevel = "normal" | "elevated" | "high" | "critical";

export interface MemoryPressureSnapshot {
  readonly level: MemoryPressureLevel;
  readonly utilizationRatio: number;
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly sampledAt: number;
}

export interface MemoryPressureHandler {
  readonly id: string;
  readonly minLevel?: Exclude<MemoryPressureLevel, "normal">;
  readonly release: (snapshot: MemoryPressureSnapshot) => void;
}

const MEMORY_PRESSURE_LEVEL_ORDER: Record<MemoryPressureLevel, number> = {
  normal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};
const DOWNGRADE_HYSTERESIS = 0.04;
const MEMORY_PRESSURE_SAMPLE_INTERVAL_MS = 2_000;
const HIGH_PRESSURE_REEMIT_INTERVAL_MS = 10_000;
const HIGH_PRESSURE_REEMIT_DELTA = 0.03;

const memoryPressureListeners = new Set<(snapshot: MemoryPressureSnapshot | null) => void>();
const memoryPressureHandlers = new Map<string, MemoryPressureHandler>();

let sampledMemoryPressureSnapshot: MemoryPressureSnapshot | null = null;
let emittedMemoryPressureSnapshot: MemoryPressureSnapshot | null = null;
let memoryPressureIntervalHandle: number | null = null;

function readDeviceMemoryGb(): number | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  const value = (navigator as NavigatorWithDeviceMemory).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readPerformanceMemory(): {
  readonly usedBytes: number;
  readonly limitBytes: number;
} | null {
  if (typeof performance === "undefined") {
    return null;
  }

  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) {
    return null;
  }

  const usedBytes = memory.usedJSHeapSize;
  const limitBytes = memory.jsHeapSizeLimit;
  if (
    typeof usedBytes !== "number" ||
    !Number.isFinite(usedBytes) ||
    usedBytes < 0 ||
    typeof limitBytes !== "number" ||
    !Number.isFinite(limitBytes) ||
    limitBytes <= 0
  ) {
    return null;
  }

  return {
    usedBytes,
    limitBytes,
  };
}

function resolveMemoryPressureThresholds(deviceMemoryGb: number | null): {
  readonly elevated: number;
  readonly high: number;
  readonly critical: number;
} {
  if (deviceMemoryGb !== null && deviceMemoryGb <= 4) {
    return {
      elevated: 0.55,
      high: 0.68,
      critical: 0.78,
    };
  }
  if (deviceMemoryGb !== null && deviceMemoryGb <= 8) {
    return {
      elevated: 0.62,
      high: 0.76,
      critical: 0.86,
    };
  }
  if (deviceMemoryGb === null) {
    return {
      elevated: 0.64,
      high: 0.78,
      critical: 0.88,
    };
  }
  return {
    elevated: 0.68,
    high: 0.82,
    critical: 0.9,
  };
}

export function compareMemoryPressureLevels(
  left: MemoryPressureLevel,
  right: MemoryPressureLevel,
): number {
  return MEMORY_PRESSURE_LEVEL_ORDER[left] - MEMORY_PRESSURE_LEVEL_ORDER[right];
}

export function classifyMemoryPressureUtilization(
  utilizationRatio: number,
  options?: {
    readonly deviceMemoryGb?: number | null;
    readonly previousLevel?: MemoryPressureLevel;
  },
): MemoryPressureLevel {
  const normalizedRatio = Math.max(0, Math.min(1, utilizationRatio));
  const thresholds = resolveMemoryPressureThresholds(
    options?.deviceMemoryGb ?? readDeviceMemoryGb(),
  );
  const previousLevel = options?.previousLevel ?? "normal";
  const elevatedThreshold =
    compareMemoryPressureLevels(previousLevel, "elevated") >= 0
      ? thresholds.elevated - DOWNGRADE_HYSTERESIS
      : thresholds.elevated;
  const highThreshold =
    compareMemoryPressureLevels(previousLevel, "high") >= 0
      ? thresholds.high - DOWNGRADE_HYSTERESIS
      : thresholds.high;
  const criticalThreshold =
    compareMemoryPressureLevels(previousLevel, "critical") >= 0
      ? thresholds.critical - DOWNGRADE_HYSTERESIS
      : thresholds.critical;

  if (normalizedRatio >= criticalThreshold) {
    return "critical";
  }
  if (normalizedRatio >= highThreshold) {
    return "high";
  }
  if (normalizedRatio >= elevatedThreshold) {
    return "elevated";
  }
  return "normal";
}

export function getCurrentMemoryPressureSnapshot(): MemoryPressureSnapshot | null {
  const performanceMemory = readPerformanceMemory();
  if (!performanceMemory) {
    sampledMemoryPressureSnapshot = null;
    return null;
  }

  const utilizationRatio = Math.max(
    0,
    Math.min(1, performanceMemory.usedBytes / performanceMemory.limitBytes),
  );
  const previousLevel = sampledMemoryPressureSnapshot?.level;
  const nextSnapshot: MemoryPressureSnapshot = {
    level: classifyMemoryPressureUtilization(
      utilizationRatio,
      previousLevel === undefined ? undefined : { previousLevel },
    ),
    utilizationRatio,
    usedBytes: performanceMemory.usedBytes,
    limitBytes: performanceMemory.limitBytes,
    sampledAt: Date.now(),
  };
  sampledMemoryPressureSnapshot = nextSnapshot;
  return nextSnapshot;
}

export function isMemoryPressureAtLeast(
  minimumLevel: Exclude<MemoryPressureLevel, "normal">,
  snapshot: MemoryPressureSnapshot | null = getCurrentMemoryPressureSnapshot(),
): boolean {
  return snapshot !== null && compareMemoryPressureLevels(snapshot.level, minimumLevel) >= 0;
}

export function shouldAvoidSpeculativeWorkForMemoryPressure(): boolean {
  return isMemoryPressureAtLeast("elevated");
}

export function shouldBypassNonEssentialCaching(): boolean {
  return isMemoryPressureAtLeast("high");
}

function shouldEmitMemoryPressureSnapshot(nextSnapshot: MemoryPressureSnapshot | null): boolean {
  const previousSnapshot = emittedMemoryPressureSnapshot;
  if (previousSnapshot === nextSnapshot) {
    return false;
  }
  if (previousSnapshot === null || nextSnapshot === null) {
    return previousSnapshot !== nextSnapshot;
  }
  if (previousSnapshot.level !== nextSnapshot.level) {
    return true;
  }
  if (!isMemoryPressureAtLeast("high", nextSnapshot)) {
    return false;
  }
  return (
    nextSnapshot.utilizationRatio - previousSnapshot.utilizationRatio >=
      HIGH_PRESSURE_REEMIT_DELTA ||
    nextSnapshot.sampledAt - previousSnapshot.sampledAt >= HIGH_PRESSURE_REEMIT_INTERVAL_MS
  );
}

function notifyMemoryPressureListeners(snapshot: MemoryPressureSnapshot | null): void {
  for (const listener of memoryPressureListeners) {
    listener(snapshot);
  }
}

function stopMemoryPressureMonitoring(): void {
  if (memoryPressureIntervalHandle !== null) {
    clearInterval(memoryPressureIntervalHandle);
    memoryPressureIntervalHandle = null;
  }
}

function ensureMemoryPressureMonitoring(): void {
  if (memoryPressureIntervalHandle !== null || memoryPressureListeners.size === 0) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }

  memoryPressureIntervalHandle = window.setInterval(() => {
    const snapshot = getCurrentMemoryPressureSnapshot();
    if (!shouldEmitMemoryPressureSnapshot(snapshot)) {
      return;
    }
    emittedMemoryPressureSnapshot = snapshot;
    notifyMemoryPressureListeners(snapshot);
  }, MEMORY_PRESSURE_SAMPLE_INTERVAL_MS);
}

export function subscribeToMemoryPressure(
  listener: (snapshot: MemoryPressureSnapshot | null) => void,
): () => void {
  memoryPressureListeners.add(listener);
  const snapshot = getCurrentMemoryPressureSnapshot();
  emittedMemoryPressureSnapshot = snapshot;
  listener(snapshot);
  ensureMemoryPressureMonitoring();

  return () => {
    memoryPressureListeners.delete(listener);
    if (memoryPressureListeners.size === 0) {
      stopMemoryPressureMonitoring();
    }
  };
}

export function registerMemoryPressureHandler(handler: MemoryPressureHandler): () => void {
  memoryPressureHandlers.set(handler.id, handler);
  return () => {
    if (memoryPressureHandlers.get(handler.id) === handler) {
      memoryPressureHandlers.delete(handler.id);
    }
  };
}

export function runMemoryPressureHandlers(snapshot: MemoryPressureSnapshot): void {
  for (const handler of memoryPressureHandlers.values()) {
    if (compareMemoryPressureLevels(snapshot.level, handler.minLevel ?? "high") < 0) {
      continue;
    }

    try {
      handler.release(snapshot);
    } catch (error) {
      console.error(`Memory pressure handler "${handler.id}" failed.`, error);
    }
  }
}

export function __resetMemoryPressureStateForTests(): void {
  stopMemoryPressureMonitoring();
  memoryPressureListeners.clear();
  sampledMemoryPressureSnapshot = null;
  emittedMemoryPressureSnapshot = null;
}
