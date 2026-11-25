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
import { WebSocket, WebSocketServer } from "ws";
import { loadIdentity } from "./tls-identity.ts";
import { bindListener, closeListener } from "./listener.ts";
import { startNativeListeners, type NativeListenersStart } from "./native-listeners.ts";
import type { MainSocket } from "./main-socket.ts";
import { NativeSocket } from "./native-socket.ts";
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
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return true;
  } catch {
    return false;
  } finally {
    server.close();
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
function upgrades(sockets?: Set<MainSocket>): NativeUpgrade {
  return {
    admit: async () => ({ decision: "accept", reservation: 0 }),
    release: () => {},
    opened: (handle) => {
      if (sockets === undefined) return;
      const socket = new NativeSocket(handle);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    },
  };
}

/** The remote listener's side of a start: native on `port`, or a TypeScript bind that answers. */
type Remote = { native: true; port: number } | { native: false; bind: () => Promise<number> };

describe.runIf(transportParts().has("loopback"))("the native listeners' start", () => {
  const internals: Server[] = [];

  afterEach(async () => {
    for (const server of internals.splice(0)) await closeListener(server);
  });

  function wiring(
    loopbackPort: number,
    remote: Remote,
    options: {
      upgrades?: NativeUpgrade;
      sockets?: Set<MainSocket>;
      closeSocket?: (socket: MainSocket) => void;
    } = {},
  ): NativeListenersStart {
    const preAuth = new PreAuthAdmission({}, () => () => {});
    const admission = {
      preAuth,
      allowedOrigins: new Set<string>(),
      servesRenderer: false,
      publicPort: () => 0,
      draining: () => false,
      full: () => false,
    };
    return {
      port: loopbackPort,
      hopSecret: transportAddon().NativeLoopback.generateSecret(),
      bindLocal: async (wanted) => {
        const internal = createServer((_request, response) => response.end("ok"));
        internals.push(internal);
        return bindListener(internal, "127.0.0.1", wanted);
      },
      loopbackUpgrades: options.upgrades ?? upgrades(),
      loopbackSockets: options.sockets ?? new Set(),
      closeSocket: options.closeSocket ?? (() => {}),
      startDraining: () => {},
      publicPort: () => {},
      tunnel: { hold: () => () => {}, track: () => {} },
      sockets: new Set(),
      nativeRemote: remote.native === true,
      admission,
      remoteWss: new WebSocketServer({ noServer: true }),
      remote:
        remote.native === true
          ? {
              native: true,
              host: "127.0.0.1",
              port: remote.port,
              advertisedHost: "127.0.0.1",
              identity,
              requests: (_request, response) => response.end("ok"),
              log: () => {},
            }
          : {
              native: false,
              host: "127.0.0.1",
              port: 0,
              advertisedHost: "127.0.0.1",
              identity,
              bind: remote.bind,
              log: () => {},
            },
    };
  }

  it("unwinds the loopback when the remote bind fails, and a retry on the freed port succeeds", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const occupant = await occupy(remotePort);
    try {
      await expect(
        startNativeListeners(wiring(loopbackPort, { native: true, port: remotePort })),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      occupant.close();
      await once(occupant, "close");
    }
    expect(await free(loopbackPort)).toBe(true);

    const listeners = await startNativeListeners(
      wiring(loopbackPort, { native: true, port: remotePort }),
    );
    expect(listeners.port).toBe(loopbackPort);
    expect(listeners.remote?.port).toBe(remotePort);
    await listeners.loopback?.close(0);
    await listeners.remote?.close(0);
    expect(await free(loopbackPort)).toBe(true);
    expect(await free(remotePort)).toBe(true);
  }, 30_000);

  it("unwinds promptly while a client holds an open loopback socket, and the client gets 1001", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const sockets = new Set<MainSocket>();
    let releaseBind!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    let bindStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bindStarted = resolve;
    });
    const attempt = startNativeListeners(
      wiring(
        loopbackPort,
        {
          native: false,
          bind: async () => {
            bindStarted();
            await held;
            throw Object.assign(new Error("listen EADDRINUSE: address already in use"), {
              code: "EADDRINUSE",
            });
          },
        },
        {
          upgrades: upgrades(sockets),
          sockets,
          closeSocket: (socket) => socket.close(1001, "Daemon shutdown"),
        },
      ),
    );
    await started;
    const client = new WebSocket(`ws://127.0.0.1:${loopbackPort}/`);
    client.on("error", () => {});
    await once(client, "open");
    // The 101 reaches the client before the binding's `opened` crosses the thread; the client holds
    // the socket once TypeScript has registered it.
    for (let waited = 0; sockets.size === 0 && waited < 5_000; waited += 10)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets.size).toBe(1);
    // Registered before the close can fire: the sweep gives 1001 as soon as the bind fails.
    const closed = once(client, "close");
    releaseBind();
    const outcome = await Promise.race([
      attempt.then(
        () => new Error("the failed start resolved"),
        (error: unknown) => error,
      ),
      new Promise<Error>((resolve) =>
        setTimeout(() => resolve(new Error("the rollback stalled")), 5_000),
      ),
    ]);
    expect(outcome).toMatchObject({ code: "EADDRINUSE" });
    const [code] = await closed;
    expect(code).toBe(1001);
    expect(await free(loopbackPort)).toBe(true);

    const listeners = await startNativeListeners(
      wiring(loopbackPort, { native: false, bind: async () => remotePort }),
    );
    await listeners.loopback?.close(0);
  }, 30_000);

  it("names a loopback bind failure in the evidence file, and writes no close for it", async () => {
    const loopbackPort = await freePort();
    const remotePort = await freePort();
    const occupant = await occupy(loopbackPort);
    const evidence = join(tmpdir(), `ace-native-listener-${process.pid}-${Date.now()}.jsonl`);
    process.env.ACE_TRANSPORT_EVIDENCE = evidence;
    try {
      await expect(
        startNativeListeners(wiring(loopbackPort, { native: true, port: remotePort })),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
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
      await expect(
        startNativeListeners(wiring(loopbackPort, { native: true, port: remotePort })),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
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
