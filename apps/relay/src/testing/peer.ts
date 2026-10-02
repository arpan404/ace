import { WebSocket } from "ws";
import type { RawData } from "ws";
import { NoiseXX, keyPair } from "@ace/secure-channel";
import type { KeyPair, Transport } from "@ace/secure-channel";
import { z } from "zod";
export const CONTROL = new TextEncoder().encode("ace relay registration v1");
export const STREAM = new TextEncoder().encode("ace daemon relay stream v1");
export function bytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}
export function address(base: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(base);
  url.pathname = path;
  url.search = new URLSearchParams(query).toString();
  return url.toString();
}
export function deferred<T>() {
  return Promise.withResolvers<T>();
}
export function peer(socket: WebSocket) {
  const frames: Buffer[] = [];
  let failure: Error | undefined;
  let waiting: { resolve(frame: Buffer): void; reject(error: Error): void } | undefined;
  const ended = deferred<number>();
  socket.on("error", (error) => {
    failure = error;
    waiting?.reject(error);
    waiting = undefined;
  });
  socket.on("close", (code) => {
    failure = new Error("Socket closed");
    waiting?.reject(failure);
    waiting = undefined;
    ended.resolve(code);
  });
  socket.on("message", (data) => {
    const frame = bytes(data);
    if (waiting) {
      const current = waiting;
      waiting = undefined;
      current.resolve(frame);
    } else frames.push(frame);
  });
  return {
    socket,
    closed: ended.promise,
    send(frame: Uint8Array) {
      return new Promise<void>((resolve, reject) =>
        socket.send(frame, { binary: true }, (e) => (e ? reject(e) : resolve())),
      );
    },
    next(): Promise<Buffer> {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close() {
      socket.terminate();
    },
  };
}
export async function openPeer(url: string) {
  const socket = new WebSocket(url, {
    maxPayload: 65535,
    perMessageDeflate: false,
    autoPong: false,
  });
  const connection = peer(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return connection;
}
export async function initiate(
  connection: ReturnType<typeof peer>,
  prologue: Uint8Array,
  keys: KeyPair = keyPair(),
  pin?: string,
): Promise<Transport> {
  const noise = new NoiseXX({
    ephemeralKey: keyPair(),
    initiator: true,
    staticKey: keys,
    prologue,
    ...(pin ? { pinnedFingerprint: pin } : {}),
  });
  await connection.send(noise.writeMessage());
  noise.readMessage(await connection.next());
  await connection.send(noise.writeMessage());
  return noise.transport;
}
export async function respond(
  connection: ReturnType<typeof peer>,
  keys: KeyPair,
): Promise<Transport> {
  const noise = new NoiseXX({
    ephemeralKey: keyPair(),
    initiator: false,
    staticKey: keys,
    prologue: STREAM,
  });
  noise.readMessage(await connection.next());
  await connection.send(noise.writeMessage());
  noise.readMessage(await connection.next());
  return noise.transport;
}
export const Registration = z.object({ type: z.literal("registered"), hostId: z.string() });
export const Offer = z.object({ type: z.literal("client"), ticket: z.string() });
export function json(frame: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(frame));
}
export async function register(relayUrl: string, keys: KeyPair = keyPair()) {
  const connection = await openPeer(address(relayUrl, "/host"));
  const transport = await initiate(connection, CONTROL, keys);
  const confirmation = Registration.parse(json(transport.receive.decrypt(await connection.next())));
  return { ...connection, transport, hostId: confirmation.hostId };
}

export function sendFrame(socket: WebSocket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.send(frame, { binary: true }, (error) => (error ? reject(error) : resolve())),
  );
}
