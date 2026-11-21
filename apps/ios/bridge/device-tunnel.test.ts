import { openMachineTunnel, type MachineTunnel } from "@ace/client/machine-tunnel";
import { portableReadableStream } from "@ace/native-host";
import { describe, expect, test } from "vitest";
import { DeviceLoopback } from "./device-loopback.ts";
import { FakeLoopbackHost } from "./device-tunnel-fixture.ts";
import { closedPort, memoryMachine } from "./tunnel-memory-machine.ts";

/*
 * The phone's loopback connections through the real tunnel and stream mux, with the bridge's own
 * ReadableStream (JavaScriptCore has none), to an in-memory machine.
 */

const schedule = (run: () => void, delayMs: number) => {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
};

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 2000 && !done(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 1));
}

/** `machineSchedule` runs the machine's own timers (its half-closed streams' deadline). */
function phone(machineSchedule = schedule) {
  const host = new FakeLoopbackHost();
  const problems = new Map<number, string | undefined>();
  const machine = memoryMachine({ ports: [5173], schedule: machineSchedule });
  const tunnel = openMachineTunnel({
    path: { get: () => machine, subscribe: () => () => {} },
    schedule,
    ReadableStream: portableReadableStream,
  });
  const loopback = new DeviceLoopback(host, () => tunnel, {
    port: (port, problem) => problems.set(port, problem),
    released: () => {},
  });
  // The page's socket sends each chunk at once and asks for the next.
  host.autoWritten = (connection) => setTimeout(() => loopback.event("written", connection, 0), 0);
  const received = (connection: string) =>
    host
      .of(connection, "write")
      .reduce((total, entry) => total + (entry.bytes?.byteLength ?? 0), 0);
  return { host, tunnel, loopback, problems, received };
}

const request = (size: number) => new TextEncoder().encode(`GET /bytes/${size} HTTP/1.1\r\n\r\n`);
const header = (size: number) =>
  `HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`.length;

describe("a device tab's connection through the tunnel", () => {
  test("a 5 MB bundle arrives whole, and the connection ends after it", async () => {
    const { host, loopback, received } = phone();
    loopback.event("accept", "c1", 5173);
    await until(() => host.of("c1", "read").length > 0);
    loopback.event("data", "c1", request(5 * 1024 * 1024));
    await until(() => host.of("c1", "end").length > 0);
    expect(received("c1")).toBe(header(5 * 1024 * 1024) + 5 * 1024 * 1024);
  });

  test("a machine that closed after its answer ends the page's connection, which goes once the page ends too", async () => {
    const { host, loopback, received } = phone();
    loopback.event("accept", "c1", 5173);
    await until(() => host.of("c1", "read").length > 0);
    loopback.event("data", "c1", request(64));
    await until(() => host.of("c1", "end").length > 0);
    expect(received("c1")).toBe(header(64) + 64);
    // As a browser does on the end of a `Connection: close` answer.
    loopback.event("end", "c1", 0);
    await until(() => loopback.open === 0);
    expect(loopback.open).toBe(0);
    expect(host.of("c1", "reset")).toHaveLength(0);
  });

  test("a page that never ends after the machine closed is closed, not reset, when the machine gives up", async () => {
    // The machine's half-closed deadline (15 s) comes at once here.
    const { host, loopback, received } = phone((run, delayMs) =>
      schedule(run, delayMs >= 15_000 ? 20 : delayMs),
    );
    loopback.event("accept", "c1", 5173);
    await until(() => host.of("c1", "read").length > 0);
    loopback.event("data", "c1", request(64));
    await until(() => host.of("c1", "close").length > 0);
    expect(received("c1")).toBe(header(64) + 64);
    expect(host.of("c1", "end")).toHaveLength(1);
    expect(host.of("c1", "close")).toHaveLength(1);
    expect(host.of("c1", "reset")).toHaveLength(0);
  });

  test("the machine's ports come through for the listeners", async () => {
    const { tunnel } = phone();
    await until(() => tunnel.ports.get().length > 0);
    expect(tunnel.ports.get()).toEqual([5173]);
  });

  test("a port with nothing on it resets the page's connection and says so", async () => {
    const { host, loopback, problems } = phone();
    loopback.event("accept", "c1", closedPort);
    await until(() => host.of("c1", "reset").length > 0);
    expect(host.of("c1", "reset")).toHaveLength(1);
    expect(problems.get(closedPort)).toBe("nothing");
  });

  test("a page connection that goes while its stream still opens gives the open up", async () => {
    const host = new FakeLoopbackHost();
    const signals: AbortSignal[] = [];
    const tunnel: MachineTunnel = {
      ports: { get: () => [5173], subscribe: () => () => {} },
      open: (_port, options) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise(() => {});
      },
      close: () => {},
    };
    const loopback = new DeviceLoopback(host, () => tunnel, {
      port: () => {},
      released: () => {},
    });
    loopback.event("accept", "c1", 5173);
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    loopback.event("reset", "c1", 0);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });
});
