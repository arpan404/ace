import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, expect, test } from "vitest";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { RemoteListener } from "./network.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { transportParts } from "@ace/provider-kit/native-switches";
import { nativeRemoteClass } from "@ace/provider-kit/native-transport";
import { remoteDirect } from "./remote-direct.ts";
import { gatedDirectListener } from "./remote-direct-test-support.ts";
import { loadIdentity } from "./tls-identity.ts";

// Real listeners on real ports: whether anything still accepts connections after remote access
// closed is the socket layer's answer, not a flag's.
const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const on = (host: string, tailnetName?: string): RemoteListener => ({
  host,
  advertisedHost: host,
  port: 0,
  identity,
  ...(tailnetName ? { tailnetName } : {}),
});

/**
 * The direct listener with real HTTPS listeners whose bind and close wait on `gates` when set,
 * as a slow interface or a busy socket layer would.
 */
function direct() {
  const gates: { bind?: Promise<void>; close?: Promise<void> } = {};
  const gated = gatedDirectListener(gates, cleanups);
  let certificates = 0;
  const remote = remoteDirect({
    options: {
      runtime: systemDeliveryRuntime,
      network: {
        interfaces: () => ({}),
        status: async () => "{}",
        identity: () => identity,
        certificate: async () => {
          certificates++;
          throw new Error("HTTPS certificates are off for this tailnet");
        },
      },
    },
    http: (_request, response) => response.writeHead(204).end(),
    attach: () => {},
    disconnect: () => {},
    clearPending: () => {},
    listener: gated.listener,
  });
  return { remote, gates, made: gated.made, ports: gated.ports, certificates: () => certificates };
}

/** Whether something accepts a TCP connection on 127.0.0.1:`port`. */
async function accepting(port: number): Promise<boolean> {
  const socket = connect(port, "127.0.0.1");
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => Promise.reject(error)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

test("a bind that finishes after remote access closed leaves nothing listening", async () => {
  const { remote, gates, made, ports } = direct();
  const bind = Promise.withResolvers<void>();
  gates.bind = bind.promise;
  // Hold Rust's own start too: the daemon retires the listener while its bind is still in
  // flight, which is the late bind this case is about (T1b.5).
  const native = transportParts().has("remote") ? nativeRemoteClass() : undefined;
  const startNative = native?.start;
  const startGate = Promise.withResolvers<void>();
  if (native !== undefined && startNative !== undefined)
    native.start = async (...args) => {
      await startGate.promise;
      return startNative(...args);
    };
  try {
    const committing = remote.commit({ lan: on("127.0.0.1") });
    await expect.poll(() => made.length).toBe(1);

    await remote.close();
    // The retire reaches the listener whose bind has not landed: its close line says so.
    const retiring = native === undefined ? undefined : made[0]?.close();
    startGate.resolve();
    bind.resolve();
    await retiring;
    await committing;
  } finally {
    if (native !== undefined && startNative !== undefined) native.start = startNative;
  }
  expect(ports).toHaveLength(1);
  expect(await accepting(ports[0] ?? 0)).toBe(false);
  expect(remote.open()).toBe(false);
  expect(remote.connection()).toBeUndefined();

  // Closed for good: a later change opens nothing.
  await remote.commit({ lan: on("127.0.0.1") });
  expect(made).toHaveLength(1);
});

test("moving to Tailscale as remote access closes opens no listener and fetches no certificate", async () => {
  const { remote, gates, made, ports, certificates } = direct();
  await remote.commit({ lan: on("127.0.0.1") });
  expect(remote.open()).toBe(true);
  const lanPort = ports[0] ?? 0;

  // Tailscale alone binds its own address, so the LAN listener goes first, slowly.
  const takeDown = Promise.withResolvers<void>();
  gates.close = takeDown.promise;
  const committing = remote.commit({ tailscale: on("127.0.0.2", "office.tailnet.ts.net") });
  const closing = remote.close();
  takeDown.resolve();
  await Promise.all([committing, closing]);

  expect(made).toHaveLength(1);
  expect(certificates()).toBe(0);
  expect(remote.open()).toBe(false);
  expect(await accepting(lanPort)).toBe(false);
});
