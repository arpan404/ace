// SPDX-License-Identifier: Apache-2.0
/**
 * The native listeners' start as one transaction (T1b.1b): a failure to bind either listener
 * unwinds the one already started, so a retry in the same process finds its ports free; and the
 * evidence file names the failure, never a close for a listener that never bound.
 */
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadIdentity } from "./tls-identity.ts";
import { bindListener, closeListener } from "./listener.ts";
import { startNativeListeners, type NativeListenersStart } from "./native-listeners.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { PreAuthAdmission } from "./socket-admission.ts";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { transportParts } from "@ace/provider-kit/native-switches";

const identity = loadIdentity(tlsFixtureHome());

/** A free port, held only for the moment it takes to read it. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

/** Whether a TCP listener can still take `port`: no leaked binding. */
async function free(port: number): Promise<boolean> {
  const server = createNetServer();
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
    return true;
  } catch {
    return false;
  } finally {
    server.close();
    await once(server, "close");
  }
}

/** One occupied port: a listener that never answers. */
async function occupy(port: number): Promise<NetServer> {
  const server = createNetServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

/** What an upgrade answers when nothing is at stake: admission's accept, no socket. */
function upgrades(): NativeUpgrade {
  return {
    admit: async () => ({ decision: "accept", reservation: 0 }),
    release: () => {},
    opened: () => {},
  };
}

describe.runIf(transportParts().has("loopback"))("the native listeners' start", () => {
  const internals: Server[] = [];

  afterEach(async () => {
    for (const server of internals.splice(0)) await closeListener(server);
  });

  function wiring(loopbackPort: number, remotePort: number): NativeListenersStart {
    const preAuth = new PreAuthAdmission({}, () => () => {});
    return {
      port: loopbackPort,
      hopSecret: transportAddon().NativeLoopback.generateSecret(),
      bindLocal: async (wanted) => {
        const internal = createServer((_request, response) => response.end("ok"));
        internals.push(internal);
        return bindListener(internal, "127.0.0.1", wanted);
      },
      loopbackUpgrades: upgrades(),
      publicPort: () => {},
      tunnel: { hold: () => () => {}, track: () => {} },
      sockets: new Set(),
      remote: {
        native: true,
        host: "127.0.0.1",
        port: remotePort,
        advertisedHost: "127.0.0.1",
        identity,
        requests: (_request, response) => response.end("ok"),
        admission: {
          preAuth,
          allowedOrigins: new Set(),
          servesRenderer: false,
          publicPort: () => 0,
          draining: () => false,
          full: () => false,
        },
        wss: new WebSocketServer({ noServer: true }),
        log: () => {},
      },
    };
  }

  it("unwinds the loopback when the remote bind fails, and a retry on the freed port succeeds", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const occupant = await occupy(remotePort);
    try {
      await expect(startNativeListeners(wiring(loopbackPort, remotePort))).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      occupant.close();
      await once(occupant, "close");
    }
    expect(await free(loopbackPort)).toBe(true);

    const listeners = await startNativeListeners(wiring(loopbackPort, remotePort));
    expect(listeners.port).toBe(loopbackPort);
    expect(listeners.remote?.port).toBe(remotePort);
    await listeners.loopback?.close(0);
    await listeners.remote?.close(0);
    expect(await free(loopbackPort)).toBe(true);
    expect(await free(remotePort)).toBe(true);
  }, 30_000);

  it("names a loopback bind failure in the evidence file, and writes no close for it", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const occupant = await occupy(loopbackPort);
    const evidence = join(tmpdir(), `ace-native-listener-${process.pid}-${Date.now()}.jsonl`);
    process.env.ACE_TRANSPORT_EVIDENCE = evidence;
    try {
      await expect(startNativeListeners(wiring(loopbackPort, remotePort))).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      delete process.env.ACE_TRANSPORT_EVIDENCE;
      occupant.close();
      await once(occupant, "close");
    }
    const lines = readFileSync(evidence, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    rmSync(evidence, { force: true });
    expect(lines).toContainEqual(
      expect.objectContaining({
        listener: "loopback",
        port: loopbackPort,
        event: "bind-failed",
        code: "EADDRINUSE",
      }),
    );
    expect(
      lines.filter((line) => line["listener"] === "loopback" && line["event"] === "close"),
    ).toEqual([]);
  }, 30_000);

  it("closes the loopback it started when the remote bind fails", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const occupant = await occupy(remotePort);
    const evidence = join(tmpdir(), `ace-native-listener-${process.pid}-${Date.now()}.jsonl`);
    process.env.ACE_TRANSPORT_EVIDENCE = evidence;
    try {
      await expect(startNativeListeners(wiring(loopbackPort, remotePort))).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      delete process.env.ACE_TRANSPORT_EVIDENCE;
      occupant.close();
      await once(occupant, "close");
    }
    const lines = readFileSync(evidence, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    rmSync(evidence, { force: true });
    expect(lines).toContainEqual(
      expect.objectContaining({ listener: "loopback", port: loopbackPort, event: "bind" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ listener: "loopback", port: loopbackPort, event: "close" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ listener: "remote", port: remotePort, event: "bind-failed" }),
    );
  }, 30_000);
});
