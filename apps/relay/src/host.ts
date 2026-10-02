import { setMaxListeners } from "node:events";
import type { KeyPair } from "@ace/secure-channel";
import { hostId, keyPair } from "@ace/secure-channel";
import type WebSocket from "ws";
import { messageChannel } from "./channel.ts";
import type { HostChannel } from "./channel.ts";
import { dial, relayAddress } from "./socket.ts";
import { handshake, CONTROL_PROLOGUE, STREAM_PROLOGUE } from "./handshake.ts";
export type HostRelayConnection = {
  readonly hostId: string;
  readonly generation: number;
  whenRegistered(afterGeneration?: number): Promise<number>;
  close(): Promise<void>;
};
/** Owns registration, client streams, retry timers and cancellation. */
export async function connectHostToRelay(options: {
  relayUrl: string;
  hostKeys: KeyPair;
  onClientChannel(channel: HostChannel): void | Promise<void>;
  signal?: AbortSignal;
}): Promise<HostRelayConnection> {
  relayAddress(options.relayUrl, "/host");
  if (hostId(keyPair(options.hostKeys.privateKey).publicKey) !== hostId(options.hostKeys.publicKey))
    throw new Error("Host key pair mismatch");
  const controller = new AbortController();
  setMaxListeners(128, controller.signal);
  const sockets = new Set<WebSocket>();
  const channels = new Set<HostChannel>();
  const tasks = new Set<Promise<void>>();
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
  async function openClient(ticket: string): Promise<void> {
    if (tasks.size + channels.size >= 64) return;
    const { socket, reader } = await dial(
      relayAddress(options.relayUrl, "/join", { ticket }),
      controller.signal,
    );
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    try {
      const transport = await handshake(socket, reader, {
        initiator: false,
        staticKey: options.hostKeys,
        prologue: STREAM_PROLOGUE,
      });
      const channel = messageChannel(socket, reader, transport, true);
      channels.add(channel);
      void channel.closed.then(() => channels.delete(channel));
      void Promise.resolve()
        .then(() => options.onClientChannel(channel))
        .catch(() => channel.close());
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }
  function retry(delay: number): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      controller.signal.addEventListener("abort", finish, { once: true });
    });
  }
  const run = (async () => {
    let delay = 250;
    while (!controller.signal.aborted) {
      let socket: WebSocket | undefined;
      try {
        const connection = await dial(relayAddress(options.relayUrl, "/host"), controller.signal);
        socket = connection.socket;
        sockets.add(socket);
        const owned = socket;
        socket.once("close", () => sockets.delete(owned));
        const transport = await handshake(socket, connection.reader, {
          initiator: true,
          staticKey: options.hostKeys,
          prologue: CONTROL_PROLOGUE,
        });
        try {
          const registered: unknown = JSON.parse(
            new TextDecoder().decode(transport.receive.decrypt(await connection.reader.next())),
          );
          if (
            !registered ||
            typeof registered !== "object" ||
            !("hostId" in registered) ||
            registered.hostId !== id ||
            !("type" in registered) ||
            registered.type !== "registered"
          )
            throw new Error("Invalid registration");
          generation++;
          delay = 250;
          for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = waiters[i]!;
            if (generation > waiter.after) {
              waiters.splice(i, 1);
              waiter.resolve(generation);
            }
          }
          while (!controller.signal.aborted) {
            const message: unknown = JSON.parse(
              new TextDecoder().decode(transport.receive.decrypt(await connection.reader.next())),
            );
            if (
              !message ||
              typeof message !== "object" ||
              !("type" in message) ||
              message.type !== "client" ||
              !("ticket" in message) ||
              typeof message.ticket !== "string" ||
              !/^[a-f0-9]{64}$/.test(message.ticket)
            )
              throw new Error("Invalid client ticket");
            const task = openClient(message.ticket).catch(() => {});
            tasks.add(task);
            void task.finally(() => tasks.delete(task));
          }
        } finally {
          transport.destroy();
        }
      } catch {
        /* Re-register with fresh ephemerals after network or relay failure. */
      } finally {
        socket?.terminate();
      }
      await retry(delay);
      delay = Math.min(delay * 2, 5000);
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
