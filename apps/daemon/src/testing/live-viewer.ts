/*
 * A person's live view over the daemon WebSocket, as the web and iOS clients hold one: screen
 * requests on the main channel, pictures as `screenFrame` stream pieces, each one acknowledged
 * so the daemon's pacing window keeps sending. For end-to-end tests of real capture paths.
 */
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";
import { decodeStreamMessage, isStreamPiece, StreamAssembler } from "@ace/browser/stream";

/** One picture as the viewer received it. */
export type ViewerFrame = {
  sessionId: string;
  streamId: string;
  sequence: number;
  width: number;
  height: number;
  codec: string;
  key: boolean;
  bytes: Buffer;
};

export class LiveViewer {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<string, (message: ServerMessage) => void>();
  readonly #frames: ViewerFrame[] = [];
  #arrived: () => void = () => {};
  #requests = 0;
  #foreign = 0;
  private constructor(socket: WebSocket) {
    this.#socket = socket;
    const assembler = new StreamAssembler();
    socket.on("message", (data, binary) => {
      if (!binary) {
        const message = ServerMessage.parse(JSON.parse(String(data)));
        if (message.type === "screen.result") this.#waiting.get(message.requestId)?.(message);
        return;
      }
      if (!Buffer.isBuffer(data) || !isStreamPiece(data)) return void this.#foreign++;
      const envelope = assembler.push(data);
      const message = envelope && decodeStreamMessage(envelope);
      if (message?.kind !== "screen.frame" || message.frame.still) return;
      const { frame } = message;
      this.#frames.push({
        sessionId: message.sourceId,
        streamId: frame.streamId,
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        codec: frame.codec,
        key: frame.key,
        bytes: Buffer.from(frame.bytes),
      });
      // Acknowledged on arrival, as a client does once its decoder has taken the picture.
      socket.send(
        JSON.stringify({
          type: "screen.ack",
          sessionId: message.sourceId,
          streamId: frame.streamId,
          sequence: frame.sequence,
        }),
      );
      this.#arrived();
    });
  }

  static async connect(url: string, tokenPath: string): Promise<LiveViewer> {
    const socket = new WebSocket(url);
    await once(socket, "open");
    const viewer = new LiveViewer(socket);
    const token = (await readFile(tokenPath, "utf8")).trim();
    const welcomed = new Promise<void>((resolve) => {
      const listener = (data: unknown, binary: boolean) => {
        if (binary || JSON.parse(String(data)).type !== "welcome") return;
        socket.off("message", listener);
        resolve();
      };
      socket.on("message", listener);
    });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, token, deviceId: "viewer" }));
    await welcomed;
    return viewer;
  }

  /** A screen request's data; throws with the daemon's error when it fails. */
  async request(operation: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const requestId = `viewer-${++this.#requests}`;
    const reply = await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No reply to ${String(operation.op)} in ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.#waiting.set(requestId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#socket.send(JSON.stringify({ type: "screen.request", requestId, operation }));
    });
    this.#waiting.delete(requestId);
    if (reply.type !== "screen.result") throw new Error("Expected a screen result");
    if (!reply.ok) throw new Error(`${String(operation.op)} failed: ${reply.error ?? "unknown"}`);
    return reply.data;
  }

  /**
   * Every picture of `sessionId` so far, once there are at least `count` (and `keyframes` of
   * them keyframes); rejects after `timeoutMs` saying how many came.
   */
  async frames(
    sessionId: string,
    want: { count: number; keyframes?: number },
    timeoutMs = 30_000,
  ): Promise<ViewerFrame[]> {
    const mine = () => this.#frames.filter((frame) => frame.sessionId === sessionId);
    const enough = () =>
      mine().length >= want.count &&
      mine().filter((frame) => frame.key).length >= (want.keyframes ?? 0);
    const deadline = Date.now() + timeoutMs;
    while (!enough()) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(
          `Wanted ${want.count} pictures (${want.keyframes ?? 0} keyframes), got ${mine().length} (${mine().filter((frame) => frame.key).length} keyframes); ${this.#foreign} foreign binary messages`,
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 500));
        this.#arrived = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return mine();
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.#socket, "close");
    this.#socket.close();
    await closed;
  }
}
