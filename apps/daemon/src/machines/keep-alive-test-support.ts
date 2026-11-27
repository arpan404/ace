import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, test } from "vitest";
import { DeviceId, HostId, ThreadId } from "@ace/protocol";
import { pinnedKeepAliveAgent } from "../client-access.ts";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { peerOf } from "../http-peer.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { testSniListener } from "../sni-test-support.ts";
import { loadIdentity } from "../tls-identity.ts";
import { MachineConnections } from "./connections.ts";
import { machineCallsHttp } from "./http.ts";
import { machineRequest } from "./transport.ts";

/*
 * How long the listener keeps a connection, on whichever runtime runs these: short before a
 * request on it authenticated, long after, and the answers' `Keep-Alive` header saying so. Bun
 * runs them from sni-keep-alive.process.test.ts, Node from sni-keep-alive-on-node.process.test.ts,
 * and `ACE_TRANSPORT=native,remote` runs them against Rust's listener (T1b.4).
 */

const token = "a".repeat(64);
const device = {
  id: DeviceId.parse("device-1"),
  name: "MacBook",
  scopes: ["read", "operate"] as const,
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
};
const origin = {
  hostId: HostId.parse("host-1"),
  hostName: "MacBook",
  threadId: ThreadId.parse("parent"),
  threadTitle: "Parent",
  ceiling: "operate" as const,
};
const schedule = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function keepAliveCases() {
  const identity = loadIdentity(tlsFixtureHome());
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  /**
   * This build's machine-calls listener: by default 300 ms before authentication and 5 s after,
   * or with the limits it ships with. Connections are counted as the transport sees them
   * (`peerOf`), which through the native hop is the hop's connection, not the request's socket.
   */
  async function listener(
    limits: { keepAlive: number; trustedKeepAlive: number } | "shipped" = {
      keepAlive: 300,
      trustedKeepAlive: 5000,
    },
  ) {
    const connections: string[] = [];
    const handler = machineCallsHttp(
      () => ({ handle: async () => ({ status: 200, body: { ok: true } }) }),
      (presented) => (presented === token ? { ...device, scopes: [...device.scopes] } : undefined),
      (_request, response) => response.writeHead(404).end(),
    );
    const server = testSniListener({
      tls: identity,
      requests: (request, response) => {
        const peer = peerOf(request);
        const connection = `${peer.address}:${peer.remotePort}`;
        if (!connections.includes(connection)) connections.push(connection);
        handler(request, response);
      },
      delay: systemDeliveryRuntime.delay,
      log: () => {},
      ...(limits === "shipped" ? {} : { limits }),
    });
    const port = await server.listen("127.0.0.1", 0);
    cleanups.push(() => server.close());
    return { connections, origin: `https://127.0.0.1:${port}/` };
  }

  /** One call on a kept-open connection of the test's own: its Keep-Alive and that connection. */
  function call(address: string, bearer: string) {
    const agent = pinnedKeepAliveAgent(identity.fingerprint, { get: () => undefined, set() {} }, 1);
    cleanups.push(() => agent.destroy());
    return new Promise<{ keepAlive: string | undefined; socket: TLSSocket }>((resolve, reject) => {
      const request = httpsRequest(
        new URL("/v1/machine-calls", address),
        { method: "POST", agent, headers: { authorization: `Bearer ${bearer}` } },
        (response) => {
          response.resume();
          const header = response.headers["keep-alive"];
          response.on("end", () =>
            resolve({
              keepAlive: typeof header === "string" ? header : undefined,
              socket: request.socket as TLSSocket,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ origin, call: { op: "describe" } }));
    });
  }

  test("calls two seconds apart on an authenticated connection reuse it, as its answers say", async () => {
    const target = await listener();
    const connections = new MachineConnections({ schedule });
    cleanups.push(() => connections.close());
    const profile = {
      id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
      name: "studio",
      origin: target.origin,
      fingerprint: identity.fingerprint,
      deviceId: device.id,
      token,
    };
    for (let i = 0; i < 4; i++) {
      await expect(
        machineRequest(
          profile,
          { origin, call: { op: "describe" } },
          { timeoutMs: 5000, connections },
        ),
      ).resolves.toEqual({ ok: true });
      // Past the short limit and Node's own one-second grace after it.
      await wait(2000);
    }
    expect(target.connections).toHaveLength(1);
    expect((await call(target.origin, token)).keepAlive).toBe("timeout=5");
  });

  test("with the shipped limits, calls past the short limit still reuse an authenticated connection", async () => {
    const target = await listener("shipped");
    const connections = new MachineConnections({ schedule });
    cleanups.push(() => connections.close());
    const profile = {
      id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
      name: "studio",
      origin: target.origin,
      fingerprint: identity.fingerprint,
      deviceId: device.id,
      token,
    };
    // The re-check and idle polling pace: well past 5 s and its grace, well inside 60 s.
    for (let i = 0; i < 3; i++) {
      await expect(
        machineRequest(
          profile,
          { origin, call: { op: "describe" } },
          { timeoutMs: 5000, connections },
        ),
      ).resolves.toEqual({ ok: true });
      if (i < 2) await wait(6500);
    }
    expect(target.connections).toHaveLength(1);
  }, 30_000);

  test("a connection that never authenticated is closed after the short limit, as its answer says", async () => {
    const target = await listener();
    const answered = await call(target.origin, "f".repeat(64));
    expect(answered.keepAlive).toBe("timeout=0");
    // The client's own socket: however the listener drops it, this end sees the close.
    await expect.poll(() => answered.socket.destroyed, { timeout: 1500 }).toBe(true);
  });
}
