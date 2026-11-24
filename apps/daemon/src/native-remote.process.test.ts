// SPDX-License-Identifier: Apache-2.0
/**
 * The remote shell hands its timers to N-API (T1b.1b). `headMs` and `trustedKeepAliveMs` are
 * optional in `ConnectionLimits`, and JavaScript says so with `null`: a start that passes them must
 * bind and serve, or the static listener's own limits are unusable.
 *
 * It also carries T1b.3b's window-bits interop: a `ws` client's
 * `server_max_window_bits=8` and `client_max_window_bits=8` offers each get the answer echoing
 * `=8` with both no-context-takeover parameters, and a 13 KiB message goes each way intact.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadIdentity } from "./tls-identity.ts";
import { startNativeRemote } from "./native-remote.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { NativeSocket } from "./native-socket.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { transportParts } from "@ace/provider-kit/native-switches";

const identity = loadIdentity(tlsFixtureHome());

/** A GET through TLS, its status the answer. */
function status(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

const upgrades: NativeUpgrade = {
  admit: async () => ({ decision: "accept", reservation: 0 }),
  release: () => {},
  opened: () => {},
};

describe.runIf(transportParts().has("remote"))("the native remote shell's timers", () => {
  it("binds and serves when the optional limits are null", async () => {
    const target = createServer((_request, response) => response.end("ok"));
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("No target port");
    const errors: string[] = [];
    const listener = await startNativeRemote({
      host: "127.0.0.1",
      port: 0,
      targetPort: address.port,
      identity,
      hopSecret: transportAddon().NativeLoopback.generateSecret(),
      limits: {
        handshakeMs: 5_000,
        firstHeadMs: 5_000,
        headMs: null,
        keepAliveMs: 5_000,
        trustedKeepAliveMs: null,
      },
      upgrade: upgrades,
      holdPort: () => () => {},
      log: (error) => errors.push(error.message),
    });
    try {
      expect(await status(listener.port())).toBe(200);
    } finally {
      await listener.close(0);
      target.close();
      await once(target, "close");
    }
    expect(errors).toEqual([]);
  }, 30_000);
});

/**
 * A listener whose opened sockets echo every message back, so a `ws` client can prove a message
 * crosses compressed and inflated intact. Each socket is tracked so the listener's close waits for
 * it, as `native-upgrade.ts` does for the daemon's own.
 */
async function echoListener() {
  const target = createServer((_request, response) => response.end("ok"));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("No target port");
  const sockets = new Set<NativeSocket>();
  const upgrade: NativeUpgrade = {
    admit: async () => ({ decision: "accept", reservation: 0 }),
    release: () => {},
    opened: (handle) => {
      const socket = new NativeSocket(handle);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    },
  };
  const listener = await startNativeRemote({
    host: "127.0.0.1",
    port: 0,
    targetPort: address.port,
    identity,
    hopSecret: transportAddon().NativeLoopback.generateSecret(),
    limits: {
      handshakeMs: 5_000,
      firstHeadMs: 5_000,
      headMs: null,
      keepAliveMs: 5_000,
      trustedKeepAliveMs: null,
    },
    upgrade,
    holdPort: () => () => {},
    log: () => {},
  });
  return {
    port: listener.port(),
    async close() {
      for (const socket of sockets) socket.close();
      await listener.close(5_000);
      target.close();
      await once(target, "close");
    },
  };
}

/** The `101`'s extension answer, from the response the client's upgrade reported. */
async function upgradeOffer(
  port: number,
  options: { serverMaxWindowBits: number } | { clientMaxWindowBits: number },
) {
  const socket = new WebSocket(`wss://127.0.0.1:${port}`, {
    rejectUnauthorized: false,
    perMessageDeflate: options,
  });
  const answered = once(socket, "upgrade") as Promise<[{ headers: Record<string, string> }]>;
  const closed = once(socket, "close");
  await once(socket, "open");
  const [response] = await answered;
  return {
    answer: response.headers["sec-websocket-extensions"],
    socket,
    async finish() {
      socket.close();
      await closed;
    },
  };
}

describe.runIf(transportParts().has("remote"))("permessage-deflate on the native listener", () => {
  it("answers both window-bits offers with =8 and both no-context-takeover parameters", async () => {
    const listener = await echoListener();
    try {
      const serverBits = await upgradeOffer(listener.port, { serverMaxWindowBits: 8 });
      expect(serverBits.answer).toBe(
        "permessage-deflate; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
      );
      await serverBits.finish();

      const clientBits = await upgradeOffer(listener.port, { clientMaxWindowBits: 8 });
      expect(clientBits.answer).toBe(
        "permessage-deflate; client_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
      );
      await clientBits.finish();
    } finally {
      await listener.close();
    }
  }, 30_000);

  it("carries a 13 KiB message both ways intact on each window-bits offer", async () => {
    const listener = await echoListener();
    const text = Array.from(
      { length: 400 },
      (_, line) => `  const value${line % 50} = await readConfig(path, { strict: true });`,
    ).join("\n");
    expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 1024);
    try {
      for (const options of [{ serverMaxWindowBits: 8 }, { clientMaxWindowBits: 8 }]) {
        const opened = await upgradeOffer(listener.port, options);
        const echoed = once(opened.socket, "message");
        opened.socket.send(text);
        const [answer] = (await echoed) as [Buffer];
        expect(answer.toString()).toBe(text);
        await opened.finish();
      }
    } finally {
      await listener.close();
    }
  }, 30_000);
});
