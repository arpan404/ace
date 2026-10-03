import { describe, expect, it } from "vitest";
import { FrameFanout, allowedOrigin } from "./index.ts";
import type { BrowserFrame } from "@ace/protocol";

const frame = (sequence: number): BrowserFrame => ({
  sequence,
  timestamp: sequence,
  data: "jpeg",
  width: 640,
  height: 480,
});
describe("browser stream backpressure", () => {
  it("lets a fast viewer progress while a slow viewer receives only the latest pending frame", () => {
    const stream = new FrameFanout();
    const fast: number[] = [],
      slow: number[] = [];
    stream.subscribe("fast", {
      send: (f) => {
        fast.push(f.sequence);
        return true;
      },
    });
    stream.subscribe("slow", {
      send: (f) => {
        slow.push(f.sequence);
        return true;
      },
    });
    for (let i = 1; i <= 100; i++) {
      stream.publish(frame(i));
      stream.acknowledge("fast", i);
    }
    expect(fast).toHaveLength(100);
    expect(slow).toEqual([1]);
    stream.acknowledge("slow", 99);
    expect(slow).toEqual([1]);
    stream.acknowledge("slow", 1);
    expect(slow).toEqual([1, 100]);
  });
  it("replaces unsent frames under transport pressure and replays the newest frame on reconnect", () => {
    const stream = new FrameFanout();
    const delivered: number[] = [];
    let blocked = true;
    const stop = stream.subscribe("viewer", {
      send: (f) => {
        if (blocked) return false;
        delivered.push(f.sequence);
        return true;
      },
    });
    stream.publish(frame(1));
    stream.publish(frame(2));
    stream.publish(frame(3));
    expect(delivered).toEqual([]);
    expect(stream.pressured).toBe(true);
    blocked = false;
    stream.flush();
    expect(delivered).toEqual([3]);
    stop();
    stream.publish(frame(4));
    stream.subscribe("viewer", {
      send: (f) => {
        delivered.push(f.sequence);
        return true;
      },
    });
    expect(delivered).toEqual([3, 4]);
  });
  it("limits subscriptions without discarding existing viewers", () => {
    const stream = new FrameFanout();
    let delivered = 0;
    for (let i = 0; i < 64; i++)
      stream.subscribe(String(i), {
        send: () => {
          delivered++;
          return true;
        },
      });
    expect(() => stream.subscribe("extra", { send: () => true })).toThrow("limit");
    stream.publish(frame(1));
    expect(delivered).toBe(64);
  });
  it("allows exact localhost names and delegates other sites to the approval hook", async () => {
    expect(await allowedOrigin("t", "http://localhost:3000")).toBe(true);
    expect(await allowedOrigin("t", "http://[::1]:3000")).toBe(true);
    expect(await allowedOrigin("t", "http://localhost.attacker.test")).toBe(false);
    expect(await allowedOrigin("t", "https://example.test")).toBe(false);
    expect(
      await allowedOrigin(
        "t",
        "https://example.test",
        ({ origin }) => origin === "https://example.test",
      ),
    ).toBe(true);
    expect(await allowedOrigin("t", "file:///tmp/a", () => true)).toBe(false);
    expect(await allowedOrigin("t", "https://user:pass@example.test", () => true)).toBe(false);
  });
});
