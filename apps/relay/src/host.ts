import { setMaxListeners } from "node:events";
import type { KeyPair } from "@ace/secure-channel";
import { hostId, keyPair } from "@ace/secure-channel";
import type WebSocket from "ws";
import { hostMessageChannel } from "./channel.ts";
import type { HostChannel } from "./channel.ts";
import { dial, relayAddress, sendFrame } from "./socket.ts";
import {
  initiateHandshake,
  respondHandshake,
  CONTROL_PROLOGUE,
  STREAM_PROLOGUE,
} from "./handshake.ts";
import { ControlMessage, HostOptionsSchema } from "./config.ts";
import { ClientSlots } from "./admission.ts";
import { systemClock, delay } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { z } from "zod";
const noop = () => {};
export type HostRelayConnection = {
  readonly hostId: string;
  readonly generation: number;
  whenRegistered(afterGeneration?: number): Promise<number>;
  close(): Promise<void>;
};
/** Owns registration, admission, client streams and cancellation. Device authentication stays in the daemon. */
export async function connectHostToRelay(options: {
  relayUrl: string;
  hostKeys: KeyPair;
  onClientChannel(channel: HostChannel): void | Promise<void>;
  signal?: AbortSignal;
  clock?: Clock;
  limits?: Partial<z.infer<typeof HostOptionsSchema>>;
}): Promise<HostRelayConnection> {
  relayAddress(options.relayUrl, "/host");
  if (hostId(keyPair(options.hostKeys.privateKey).publicKey) !== hostId(options.hostKeys.publicKey))
    throw new Error("Host key pair mismatch");
  const limits = HostOptionsSchema.parse(options.limits ?? {});
  const clock = options.clock ?? systemClock();
  const controller = new AbortController();
  setMaxListeners(2 * limits.maxClientChannels + 16, controller.signal);
  const sockets = new Set<WebSocket>();
  const channels = new Set<HostChannel>();
  const tasks = new Set<Promise<void>>();
  const slots = new ClientSlots(limits.maxClientChannels);
  const pending = new Map<string, AbortController>();
  let generation = 0;
  const waiters: { after: number; resolve(value: number): void; reject(error: Error): void }[] = [];
  const id = hostId(options.hostKeys.publicKey);
  const cancel = () => {
    controller.abort();
    for (const socket of sockets) socket.terminate();
    for (const channel of channels) channel.close();
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Host connection closed"));
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  async function openClient(ticket: string, owned: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, owned.signal]);
    let channel: HostChannel | undefined;
    let seenHello = false;
    const expire = clock.schedule(limits.helloTimeoutMs, () => {
      channel?.close();
      owned.abort();
    });
    try {
      const { socket, reader } = await dial(
        relayAddress(options.relayUrl, "/join", { ticket }),
        signal,
        clock,
        limits.handshakeTimeoutMs,
      );
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const transport = await respondHandshake(socket, reader, {
        staticKey: options.hostKeys,
        prologue: STREAM_PROLOGUE,
        clock,
        timeoutMs: limits.handshakeTimeoutMs,
      });
      channel = hostMessageChannel(
        socket,
        reader,
        transport,
        (message) => {
          if (!seenHello) {
            if (message instanceof Uint8Array || message.type !== "hello")
              throw new Error("First message must be hello");
            seenHello = true;
          }
        },
        () => {
          if (!seenHello) throw new Error("Device hello has not been received");
          if (signal.aborted) throw new Error("Channel expired");
          slots.authorize(ticket);
          expire();
        },
      );
      const opened = channel;
      channels.add(opened);
      void Promise.resolve()
        .then(() => options.onClientChannel(opened))
        .catch(() => opened.close());
      await opened.closed;
    } finally {
      expire();
      owned.abort();
      slots.release(ticket);
      pending.delete(ticket);
      if (channel) channels.delete(channel);
    }
  }
  const run = (async () => {
    let retryMs = limits.retryInitialMs;
    while (!controller.signal.aborted) {
      let socket: WebSocket | undefined;
      let expire: () => void = noop;
      try {
        const connection = await dial(
          relayAddress(options.relayUrl, "/host"),
          controller.signal,
          clock,
          limits.handshakeTimeoutMs,
        );
        socket = connection.socket;
        sockets.add(socket);
        const owned = socket;
        socket.once("close", (code) => {
          sockets.delete(owned);
          if (code === 4001) cancel();
        });
        expire = clock.schedule(limits.handshakeTimeoutMs, () => owned.terminate());
        const transport = await initiateHandshake(socket, connection.reader, {
          staticKey: options.hostKeys,
          prologue: CONTROL_PROLOGUE,
          clock,
          timeoutMs: limits.handshakeTimeoutMs,
        });
        try {
          const registered = ControlMessage.parse(
            JSON.parse(
              new TextDecoder().decode(transport.receive.decrypt(await connection.reader.next())),
            ),
          );
          if (registered.type !== "registered" || registered.hostId !== id)
            throw new Error("Invalid registration");
          expire();
          generation++;
          retryMs = limits.retryInitialMs;
          for (const waiter of waiters.splice(0)) {
            if (generation > waiter.after) waiter.resolve(generation);
            else waiters.push(waiter);
          }
          while (!controller.signal.aborted) {
            const message = ControlMessage.parse(
              JSON.parse(
                new TextDecoder().decode(transport.receive.decrypt(await connection.reader.next())),
              ),
            );
            if (message.type !== "client") throw new Error("Invalid client ticket");
            const reservation = slots.reserve(message.ticket);
            if (!reservation.accepted) {
              await sendFrame(
                socket,
                transport.send.encrypt(
                  new TextEncoder().encode(
                    JSON.stringify({ type: "reject", ticket: message.ticket }),
                  ),
                ),
              );
              continue;
            }
            if (reservation.evicted) pending.get(reservation.evicted)?.abort();
            const ownedClient = new AbortController();
            pending.set(message.ticket, ownedClient);
            const task = openClient(message.ticket, ownedClient).catch(() => {});
            tasks.add(task);
            void task.finally(() => tasks.delete(task));
          }
        } finally {
          transport.destroy();
        }
      } catch {
        /* Re-register with fresh ephemerals after network or relay failure. */
      } finally {
        expire();
        socket?.terminate();
      }
      await delay(clock, retryMs, controller.signal);
      retryMs = Math.min(retryMs * 2, limits.retryMaxMs);
    }
  })();
  const result: HostRelayConnection = {
    hostId: id,
    get generation() {
      return generation;
    },
    whenRegistered(after = 0) {
      if (controller.signal.aborted) return Promise.reject(new Error("Host connection closed"));
      if (generation > after) return Promise.resolve(generation);
      if (waiters.length >= 1024) return Promise.reject(new Error("Too many registration waiters"));
      return new Promise((resolve, reject) => waiters.push({ after, resolve, reject }));
    },
    async close() {
      cancel();
      options.signal?.removeEventListener("abort", cancel);
      await run;
      await Promise.all(tasks);
    },
  };
  try {
    await result.whenRegistered();
    return result;
  } catch (error) {
    await result.close();
    throw error;
  }
}
