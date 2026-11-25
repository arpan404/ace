// SPDX-License-Identifier: Apache-2.0
import { WebSocketServer } from "ws";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { transportParts } from "@ace/provider-kit/native-switches";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { MainSocket } from "./main-socket.ts";
import { nativeSniListeners } from "./native-sni-listener.ts";
import { NativeSocket } from "./native-socket.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { sniListener, type SniListener, type SniListenerOptions } from "./sni-listener.ts";
import type { TrustedCertificate } from "./tailscale-certificate.ts";

/**
 * The HTTPS listener a test builds, by whichever backend `ACE_TRANSPORT` selects: the `node:tls`
 * one with the certificate's `SNICallback`, or the native one, which is told the certificate
 * instead (T1b.4). The cases then run once per leg on the same file.
 */
export interface TestSniListener extends SniListener {
  /** Native leg: where the listener hands a socket whose `101` is on the wire. */
  onOpened?(handler: (socket: MainSocket) => void): void;
}

/** What a test's socket server opened, whichever listener carried the upgrades. */
export interface TestSocketServer {
  /** The sockets open now: a case closes them with a code on either leg. */
  clients(): MainSocket[];
  close(): void;
}

export function testSniListener(
  options: SniListenerOptions,
  certificate?: TrustedCertificate,
): TestSniListener {
  if (!transportParts().has("remote")) {
    return sniListener({
      ...options,
      ...(certificate === undefined
        ? {}
        : {
            tls: {
              ...options.tls,
              SNICallback: (servername, done) => done(null, certificate.select(servername)),
            },
          }),
    });
  }
  let opened: ((socket: MainSocket) => void) | undefined;
  const upgrades = (): NativeUpgrade => ({
    admit: async () => ({ decision: "accept", reservation: 0 }),
    release: () => {},
    opened: (handle) => opened?.(new NativeSocket(handle)),
  });
  const listener = nativeSniListeners({
    secret: transportAddon().NativeLoopback.generateSecret(),
    upgrades,
    delay: options.delay,
    now: systemDeliveryRuntime.now,
    // No public port of a test's to hold: nothing else on the machine claims it.
    tunnel: { hold: () => () => {} },
  }).make(options);
  listener.trust?.(certificate);
  return Object.assign(listener, {
    onOpened: (handler: (socket: MainSocket) => void) => {
      opened = handler;
    },
  });
}

/**
 * A WebSocket server on `listener`, wired the way the daemon wires it: `ws`'s `handleUpgrade` on
 * Node's listener, the listener's own `opened` callback on the native one. Called before `listen`,
 * because the native listener never asks for an upgrade it has no handler for.
 */
export function testSocketServer(
  listener: TestSniListener,
  onOpen: (socket: MainSocket) => void,
): TestSocketServer {
  if (listener.onOpened !== undefined) {
    const open = new Set<MainSocket>();
    listener.onOpened((socket) => {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
      onOpen(socket);
    });
    return {
      clients: () => [...open],
      close: () => {
        for (const socket of open) socket.terminate();
      },
    };
  }
  const wss = new WebSocketServer({ noServer: true });
  listener.http.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) => onOpen(ws)),
  );
  return { clients: () => [...wss.clients], close: () => wss.close() };
}
