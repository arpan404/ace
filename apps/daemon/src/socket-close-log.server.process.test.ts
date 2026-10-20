import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceId } from "@ace/protocol";
import { createLogger, type LogRecord } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { Client, fixture, token } from "./socket-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** The daemon's own wiring: server warnings go through the bounded logger. */
function daemonLog() {
  const records: LogRecord[] = [];
  const logger = createLogger({
    sink: {
      async write(batch) {
        records.push(...batch);
      },
      async close() {},
    },
    now: () => 1,
    redact: createRedactor({ home: "/Users/someone", env: {} }),
  });
  return {
    records,
    warn: (message: string, fields: object) => logger.log("warn", message, fields),
    flush: () => logger.flush(),
  };
}

it("a WebSocket heartbeat loss is logged with its code, reason, duration and client kind", async () => {
  const log = daemonLog();
  const f = await fixture({ idleTimeoutMs: 200, warn: log.warn });
  cleanups.push(() => f.close());
  const client = new Client(f.server.url, {
    headers: { "User-Agent": "ace/42 CFNetwork/1568.100.1 Darwin/25.0.0" },
  });
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("phone"), token });
  await client.next();
  const [code] = await once(client.socket, "close");
  expect(code).toBe(4008);
  const closed = await vi.waitFor(async () => {
    await log.flush();
    const record = log.records.find((entry) => entry.message === "WebSocket closed");
    if (!record) throw new Error("No close record yet");
    return record;
  });
  expect(closed.data).toEqual({
    code: 4008,
    reason: "Idle timeout",
    durationMs: expect.any(Number),
    authenticated: true,
    client: "ios",
    access: "host",
    remote: false,
  });
});

it("the daemon's own shutdown closing its sockets is not logged as a client close", async () => {
  const log = daemonLog();
  const f = await fixture({ warn: log.warn });
  const client = await f.connect();
  await client.next();
  const closed = once(client.socket, "close");
  await f.server.close();
  await closed;
  await f.close();
  await log.flush();
  expect(log.records.filter((record) => record.message === "WebSocket closed")).toEqual([]);
});
