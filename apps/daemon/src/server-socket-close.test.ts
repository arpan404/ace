import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createSocketCloser, DAEMON_CLOSE_GRACE_MS } from "./server-socket-close.ts";

interface Timer {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

/** Time mocked at the boundary: tests fire deadlines by hand, never by sleep. */
function manualDelay() {
  const pending: Timer[] = [];
  const delay = (callback: () => void, ms: number) => {
    const timer: Timer = { callback, ms, cancelled: false };
    pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { delay, pending };
}

function fire(timer: Timer | undefined) {
  if (!timer || timer.cancelled) throw new Error("expected a live deadline");
  timer.callback();
}

async function listen(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { wss, port: address.port };
}

const CLOSE_BYTES = 2 + 2 + Buffer.byteLength("Daemon shutdown");

/** A peer that never acks: raw TCP through the HTTP upgrade, then silence. */
async function rawPeer(port: number): Promise<Socket> {
  const raw = connect(port, "127.0.0.1");
  await once(raw, "connect");
  const received: Buffer[] = [];
  let waiting: { bytes: number; resolve: (value: Buffer) => void } | undefined;
  raw.on("data", (chunk: Buffer) => {
    received.push(chunk);
    if (!waiting) return;
    const buffered = Buffer.concat(received);
    if (buffered.length < waiting.bytes) return;
    const { bytes, resolve } = waiting;
    waiting = undefined;
    received.splice(0, received.length, buffered.subarray(bytes));
    resolve(buffered.subarray(0, bytes));
  });
  const take = (bytes: number): Promise<Buffer> =>
    new Promise<Buffer>((resolve) => {
      const buffered = Buffer.concat(received);
      if (buffered.length >= bytes) {
        received.splice(0, received.length, buffered.subarray(bytes));
        resolve(buffered.subarray(0, bytes));
        return;
      }
      waiting = { bytes, resolve };
    });
  raw.write(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const status = await take(12);
  expect(status.toString()).toBe("HTTP/1.1 101");
  let rest = Buffer.concat(received);
  while (!rest.includes("\r\n\r\n")) {
    await once(raw, "data");
    rest = Buffer.concat(received);
  }
  const end = rest.indexOf("\r\n\r\n") + 4;
  received.splice(0, received.length, rest.subarray(end));
  return raw;
}

async function closeServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

it("delivers the shutdown code and reason to a live peer, then owes it no drop", async () => {
  const { wss, port } = await listen();
  try {
    const { delay, pending } = manualDelay();
    const closer = createSocketCloser(delay);
    const accepted = once(wss, "connection") as Promise<[WebSocket]>;
    const peer = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      const [serverSocket] = await accepted;
      await once(peer, "open");
      const serverClosed = once(serverSocket, "close");
      const peerClosed = once(peer, "close") as Promise<[number, Buffer]>;
      closer.gracefulClose(serverSocket, 1001, "Daemon shutdown");
      const [code, reason] = await peerClosed;
      expect(code).toBe(1001);
      expect(reason.toString()).toBe("Daemon shutdown");
      await serverClosed;
      // The ack spent the bound: firing every deadline afterwards drops nothing new.
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((timer) => timer.cancelled)).toBe(true);
      for (const timer of pending) timer.callback();
      expect(serverSocket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      peer.terminate();
    }
  } finally {
    await closeServer(wss);
  }
});

it("holds an unacked peer's close frame on the wire, then drops it on the deadline", async () => {
  const { wss, port } = await listen();
  try {
    const { delay, pending } = manualDelay();
    const closer = createSocketCloser(delay);
    const accepted = once(wss, "connection") as Promise<[WebSocket]>;
    const raw = await rawPeer(port);
    try {
      const [serverSocket] = await accepted;
      const frameArrived = new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        raw.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const buffered = Buffer.concat(chunks);
          if (buffered.length >= CLOSE_BYTES) resolve(buffered.subarray(0, CLOSE_BYTES));
        });
      });
      closer.gracefulClose(serverSocket, 1001, "Daemon shutdown");
      // Server-to-client frames are unmasked: FIN+close, length, code, reason.
      const frame = await frameArrived;
      expect(frame[0]).toBe(0x88);
      expect(frame[1]).toBe(CLOSE_BYTES - 2);
      expect(frame.readUInt16BE(2)).toBe(1001);
      expect(frame.subarray(4).toString()).toBe("Daemon shutdown");
      // Never acked: the deadline still drops the socket.
      expect(pending[0]?.ms).toBe(DAEMON_CLOSE_GRACE_MS);
      const closed = once(raw, "close");
      fire(pending[0]);
      await closed;
      expect(serverSocket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      raw.destroy();
    }
  } finally {
    await closeServer(wss);
  }
});

it("puts exactly one close frame on the wire when a late sweep repeats the shutdown", async () => {
  const { wss, port } = await listen();
  try {
    const { delay, pending } = manualDelay();
    const closer = createSocketCloser(delay);
    const accepted = once(wss, "connection") as Promise<[WebSocket]>;
    const raw = await rawPeer(port);
    try {
      const [serverSocket] = await accepted;
      const chunks: Buffer[] = [];
      raw.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      closer.gracefulClose(serverSocket, 1001, "Daemon shutdown");
      closer.gracefulClose(serverSocket, 1001, "Daemon shutdown");
      const closed = once(raw, "close");
      for (const timer of pending) {
        if (!timer.cancelled) timer.callback();
      }
      await closed;
      // The handshake drained before these listeners attached, so this is every
      // byte the shutdown put on the wire: one frame, never two.
      expect(Buffer.concat(chunks)).toHaveLength(CLOSE_BYTES);
    } finally {
      raw.destroy();
    }
  } finally {
    await closeServer(wss);
  }
});
