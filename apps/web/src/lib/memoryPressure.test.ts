import { describe, expect, it, vi } from "vitest";

import {
  classifyMemoryPressureUtilization,
  registerMemoryPressureHandler,
  runMemoryPressureHandlers,
  type MemoryPressureSnapshot,
} from "./memoryPressure";

describe("classifyMemoryPressureUtilization", () => {
  it("starts shedding earlier on constrained devices", () => {
    expect(classifyMemoryPressureUtilization(0.7, { deviceMemoryGb: 4 })).toBe("high");
    expect(classifyMemoryPressureUtilization(0.7, { deviceMemoryGb: 16 })).toBe("elevated");
  });

  it("uses hysteresis before downgrading from high pressure", () => {
    expect(
      classifyMemoryPressureUtilization(0.79, {
        deviceMemoryGb: 16,
        previousLevel: "high",
      }),
    ).toBe("high");
    expect(
      classifyMemoryPressureUtilization(0.74, {
        deviceMemoryGb: 16,
        previousLevel: "high",
      }),
    ).toBe("elevated");
  });
});

describe("runMemoryPressureHandlers", () => {
  it("runs only handlers whose threshold is met", () => {
    const highHandler = vi.fn();
    const criticalHandler = vi.fn();
    const unregisterHighHandler = registerMemoryPressureHandler({
      id: "test-high-handler",
      minLevel: "high",
      release: highHandler,
    });
    const unregisterCriticalHandler = registerMemoryPressureHandler({
      id: "test-critical-handler",
      minLevel: "critical",
      release: criticalHandler,
    });
    const snapshot: MemoryPressureSnapshot = {
      level: "high",
      utilizationRatio: 0.84,
      usedBytes: 840,
      limitBytes: 1_000,
      sampledAt: 1,
    };

    try {
      runMemoryPressureHandlers(snapshot);
    } finally {
      unregisterHighHandler();
      unregisterCriticalHandler();
    }

    expect(highHandler).toHaveBeenCalledWith(snapshot);
    expect(criticalHandler).not.toHaveBeenCalled();
  });
});
