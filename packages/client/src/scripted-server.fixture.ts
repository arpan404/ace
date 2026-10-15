import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { ClientMessage, DeviceId, type ClientMessage as Frame } from "@ace/protocol";
import { Client, webSocketTransport, type Limits } from "./index.ts";
import { ManualScheduler, memoryStorage } from "./test-support.ts";

export const hostId = "6f1c2a8e-4b7d-4e2a-9c1f-2d3b4a5c6d7e";

/** One socket the client opened, scripted by the test: it reads frames and answers by hand. */
export class Peer {
  readonly received: Frame[] = [];
  #socket: ServerSocket;
  #taken = new Set<Frame>();
  #arrived: (() => void)[] = [];
  constructor(socket: ServerSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const frame = ClientMessage.parse(JSON.parse(data.toString()));
      this.received.push(frame);
      if (frame.type === "ping") this.send({ type: "pong" });
      for (const arrived of this.#arrived.splice(0)) arrived();
    });
  }
  /** The next frame of `type` not yet taken, received already or still to come. */
  async next<T extends Frame["type"]>(type: T): Promise<Extract<Frame, { type: T }>> {
    const is = (frame: Frame): frame is Extract<Frame, { type: T }> =>
      frame.type === type && !this.#taken.has(frame);
    for (;;) {
      const frame = this.received.find(is);
      if (frame) {
        this.#taken.add(frame);
        return frame;
      }
      await new Promise<void>((resolve) => this.#arrived.push(resolve));
    }
  }
  send(message: object): void {
    this.#socket.send(JSON.stringify(message));
  }
  welcome(protocolVersion = 1): void {
    this.send({ type: "welcome", hostId, protocolVersion, headSeq: 0 });
  }
  close(code: number, reason: string): void {
    this.#socket.close(code, reason);
  }
}

/**
 * A local WebSocket server whose every connection the test scripts, and a client on manual
 * time pointed at it.
 */
export async function scripted(limits: Partial<Limits> = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing address");
  const peers: Peer[] = [];
  const waiting = new Map<number, (peer: Peer) => void>();
  server.on("connection", (socket) => {
    const peer = new Peer(socket);
    peers.push(peer);
    waiting.get(peers.length - 1)?.(peer);
  });
  const scheduler = new ManualScheduler();
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("scripted-device"),
    transport: () => webSocketTransport(() => new WebSocket(`ws://127.0.0.1:${address.port}`)),
    storage: memoryStorage(),
    credential: async () => "a".repeat(64),
    scheduler,
    random: () => 0.5,
    id: () => `scripted-${++sequence}`,
    // Heartbeats and handshakes stay out of the way of long jumps on the manual clock.
    limits: { heartbeatMs: 3_600_000, handshakeMs: 3_600_000, ...limits },
  });
  return {
    client,
    scheduler,
    /** The socket the client opened `index`th, counting from 0. */
    connection(index: number): Promise<Peer> {
      const peer = peers[index];
      return peer ? Promise.resolve(peer) : new Promise((resolve) => waiting.set(index, resolve));
    },
    async close() {
      await client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
