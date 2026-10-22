/*
 * A person's live view over the daemon WebSocket, as the web and iOS clients hold one: requests
 * on the main channel (screen sessions) or the devices channel (simulators and emulators),
 * pictures as stream pieces, each one acknowledged so the daemon's pacing window keeps
 * sending. For end-to-end tests of real capture paths.
 */
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { z } from "zod";
import { decodeStreamMessage, isStreamPiece, StreamAssembler } from "@ace/browser/stream";

/** One picture as the viewer received it. */
export type ViewerFrame = {
  /** The screen session or device it shows. */
  sessionId: string;
  streamId: string;
  sequence: number;
  width: number;
  height: number;
  /** Picture pixels per point of the target: a point for input is a pixel over this. */
  scale: number;
  codec: string;
  key: boolean;
  bytes: Buffer;
  /** When the viewer received it (`performance.now()`). */
  receivedAt: number;
};

/** What a viewer watches: computer-use screen sessions, or app devices. */
export type Surface = "screen" | "devices";

const words = {
  screen: { request: "screen.request", result: "screen.result", frame: "screen.frame" },
  devices: { request: "devices.request", result: "devices.result", frame: "device.frame" },
} as const;

const Result = z.object({
  type: z.string(),
  requestId: z.string().optional(),
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  /** A screen failure is its message; a device failure an object with a code and hint. */
  error: z.unknown().optional(),
});
type Result = z.infer<typeof Result>;

export class LiveViewer {
  readonly #socket: WebSocket;
  readonly #surface: Surface;
  readonly #waiting = new Map<string, (message: Result) => void>();
  readonly #frames: ViewerFrame[] = [];
  #arrived: () => void = () => {};
  #requests = 0;
  #foreign = 0;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  private constructor(socket: WebSocket, surface: Surface) {
    this.#socket = socket;
    this.#surface = surface;
    // The daemon closes a socket quiet for a minute; clients ping, so a long wait stays open.
    this.#heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), 20_000);
    socket.on("close", () => clearInterval(this.#heartbeat));
    const assembler = new StreamAssembler();
    socket.on("message", (data, binary) => {
      if (!binary) {
        const message = Result.parse(JSON.parse(String(data)));
        if (message.type === words[surface].result && message.requestId)
          this.#waiting.get(message.requestId)?.(message);
        return;
      }
      if (!Buffer.isBuffer(data) || !isStreamPiece(data)) return void this.#foreign++;
      const envelope = assembler.push(data);
      const message = envelope && decodeStreamMessage(envelope);
      if (message?.kind !== words[surface].frame || message.frame.still) return;
      const { frame } = message;
      this.#frames.push({
        sessionId: message.sourceId,
        streamId: frame.streamId,
        sequence: frame.sequence,
        width: frame.width,
        height: frame.height,
        scale: frame.scale,
        codec: frame.codec,
        key: frame.key,
        bytes: Buffer.from(frame.bytes),
        receivedAt: performance.now(),
      });
      // Acknowledged on arrival, as a client does once its decoder has taken the picture.
      const ack = { streamId: frame.streamId, sequence: frame.sequence };
      socket.send(
        JSON.stringify(
          surface === "screen"
            ? { type: "screen.ack", sessionId: message.sourceId, ...ack }
            : { type: "devices.ack", deviceId: message.sourceId, ...ack },
        ),
      );
      this.#arrived();
    });
  }

  static async connect(
    url: string,
    tokenPath: string,
    surface: Surface = "screen",
  ): Promise<LiveViewer> {
    const socket = new WebSocket(url);
    await once(socket, "open");
    const viewer = new LiveViewer(socket, surface);
    const token = (await readFile(tokenPath, "utf8")).trim();
    const welcomed = new Promise<void>((resolve) => {
      const listener = (data: unknown, binary: boolean) => {
        if (binary || JSON.parse(String(data)).type !== "welcome") return;
        socket.off("message", listener);
        resolve();
      };
      socket.on("message", listener);
    });
    const channel = surface === "devices" ? { channel: "devices" } : {};
    socket.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, token, deviceId: "viewer", ...channel }),
    );
    await welcomed;
    return viewer;
  }

  /** A request's data; throws with the daemon's error when it fails. */
  async request(operation: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const requestId = `viewer-${++this.#requests}`;
    const reply = await new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No reply to ${String(operation.op)} in ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.#waiting.set(requestId, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#socket.send(
        JSON.stringify({ type: words[this.#surface].request, requestId, operation }),
      );
    });
    this.#waiting.delete(requestId);
    if (!reply.ok) {
      const error = typeof reply.error === "string" ? reply.error : JSON.stringify(reply.error);
      throw new Error(`${String(operation.op)} failed: ${error ?? "unknown"}`);
    }
    return reply.data;
  }

  /**
   * Every picture of `sessionId` so far, once there are at least `count` (and `keyframes` of
   * them keyframes) and, with `afterMs`, that long has passed: a change made before the call
   * has been captured by then. Rejects after `timeoutMs` saying how many came.
   */
  async frames(
    sessionId: string,
    want: { count: number; keyframes?: number; afterMs?: number },
    timeoutMs = 30_000,
  ): Promise<ViewerFrame[]> {
    const mine = () => this.#frames.filter((frame) => frame.sessionId === sessionId);
    const from = Date.now();
    const enough = () =>
      mine().length >= want.count &&
      mine().filter((frame) => frame.key).length >= (want.keyframes ?? 0) &&
      Date.now() - from >= (want.afterMs ?? 0);
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
    clearInterval(this.#heartbeat);
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.#socket, "close");
    this.#socket.close();
    await closed;
  }
}
