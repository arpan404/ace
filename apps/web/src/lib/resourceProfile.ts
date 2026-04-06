import { shouldAvoidSpeculativeWorkForMemoryPressure } from "./memoryPressure";

interface NetworkInformationLike {
  readonly effectiveType?: string;
  readonly saveData?: boolean;
}

interface NavigatorResourceHints extends Navigator {
  readonly connection?: NetworkInformationLike;
  readonly deviceMemory?: number;
}

export type ClientMemoryClass = "unknown" | "constrained" | "moderate" | "standard";

export interface ClientResourceProfile {
  readonly memoryClass: ClientMemoryClass;
  readonly deviceMemoryGb: number | null;
  readonly saveData: boolean;
  readonly slowNetwork: boolean;
}

const SLOW_EFFECTIVE_NETWORK_TYPES = new Set(["slow-2g", "2g"]);

function readNavigatorResourceHints(): NavigatorResourceHints | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return navigator as NavigatorResourceHints;
}

export function getClientResourceProfile(): ClientResourceProfile {
  const resourceHints = readNavigatorResourceHints();
  const rawDeviceMemory = resourceHints?.deviceMemory;
  const deviceMemoryGb =
    typeof rawDeviceMemory === "number" && Number.isFinite(rawDeviceMemory) && rawDeviceMemory > 0
      ? rawDeviceMemory
      : null;
  const effectiveType = resourceHints?.connection?.effectiveType ?? null;
  const saveData = resourceHints?.connection?.saveData === true;
  const slowNetwork = effectiveType !== null && SLOW_EFFECTIVE_NETWORK_TYPES.has(effectiveType);
  const memoryClass: ClientMemoryClass =
    deviceMemoryGb === null
      ? "unknown"
      : deviceMemoryGb <= 4
        ? "constrained"
        : deviceMemoryGb <= 8
          ? "moderate"
          : "standard";

  return {
    memoryClass,
    deviceMemoryGb,
    saveData,
    slowNetwork,
  };
}

export function shouldAvoidSpeculativeWork(): boolean {
  const profile = getClientResourceProfile();
  return (
    profile.saveData ||
    profile.slowNetwork ||
    profile.memoryClass === "constrained" ||
    shouldAvoidSpeculativeWorkForMemoryPressure()
  );
}

export function clampCacheBudgetBytes(
  requestedBytes: number,
  options: {
    readonly moderateCapBytes?: number;
    readonly constrainedCapBytes: number;
  },
): number {
  const profile = getClientResourceProfile();
  if (profile.memoryClass === "constrained") {
    return Math.min(requestedBytes, options.constrainedCapBytes);
  }
  if (profile.memoryClass === "moderate" && options.moderateCapBytes !== undefined) {
    return Math.min(requestedBytes, options.moderateCapBytes);
  }
  return requestedBytes;
}

export function clampCacheEntryCount(
  requestedEntries: number,
  options: {
    readonly moderateCapEntries?: number;
    readonly constrainedCapEntries: number;
  },
): number {
  const profile = getClientResourceProfile();
  if (profile.memoryClass === "constrained") {
    return Math.min(requestedEntries, options.constrainedCapEntries);
  }
  if (profile.memoryClass === "moderate" && options.moderateCapEntries !== undefined) {
    return Math.min(requestedEntries, options.moderateCapEntries);
  }
  return requestedEntries;
}
