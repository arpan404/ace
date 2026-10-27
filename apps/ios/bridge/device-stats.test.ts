import { describe, expect, test } from "vitest";
import { DeviceStats, DeviceStatsControl } from "./device-stats.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/* The phone's stream stats: Swift's once-a-second batches of what arrived and was drawn. */

const batch = (value: Partial<DeviceStatsControl> & { now: number }) =>
  DeviceStatsControl.parse({ type: "native.devices.stats", deviceId: "sim-1", ...value });

describe("A device's stream stats on the phone", () => {
  test("a second of drawn pictures reads as their rate, with no delay claimed across machines", () => {
    const sink = new RecordingSink();
    const stats = new DeviceStats(sink);
    // A picture a second ago, then the last second's sixty.
    stats.handle(batch({ now: 900, drawn: [[400, 900]], received: [[895, 40_000]] }));
    const drawn = Array.from(
      { length: 60 },
      (_, index) => [500 + index * 16, 1001 + index * 16] as [number, number],
    );
    const received = drawn.map(([, shown]) => [shown, 40_000] as [number, number]);
    stats.handle(batch({ now: 2000, drawn, received }));
    expect(sink.read("devices:stats:sim-1")?.summary).toBe("H.264 · 60 fps");
    const details = sink.read("devices:stats:sim-1")?.details as string[];
    expect(details[0]).toBe("Received 60/s · drawn 60/s");
    expect(details.at(-1)).toBe("Decoder: hardware (VideoToolbox)");
  });

  test("a long stall and the keyframes asked for show; hiding the stats forgets them", () => {
    const sink = new RecordingSink();
    const stats = new DeviceStats(sink);
    stats.handle(
      batch({
        now: 1000,
        drawn: [
          [0, 100],
          [0, 900],
        ],
        keyframes: [950],
      }),
    );
    const details = sink.read("devices:stats:sim-1")?.details as string[];
    expect(details).toContain("Longest stall 800 ms (5 s)");
    expect(details).toContain("Keyframes asked 1 (5 s)");
    stats.handle(batch({ now: 1100, stop: true }));
    expect(sink.read("devices:stats:sim-1")).toBeUndefined();
  });
});
