import {
  MediaStreamServerMessage,
  mediaHelloBytes,
  mediaHelloMagic,
  mediaHelloVersion,
  type MediaConnectGranted,
  type MediaStreamClientMessage,
} from "@ace/protocol";

/*
 * A standalone media-connection client (docs/media/plan.md, Wave 6): `media.connect`'s grant,
 * the media connection's hello, its pieces, acks and pings, and the relay media hello. D1 and D2
 * are accepted with it, so they don't wait for the real web and iOS clients (C1, C2).
 *
 * It holds no media knowledge: pieces go to the caller as they arrive, and the caller (a test or
 * `packages/browser/bench/media-link.ts`) decodes them with the client's own decoders.
 */

/** The media connection's binary hello for a `media.connect` ticket (base64url). */
export function mediaHello(ticket: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(ticket, "base64url");
  if (bytes.length !== mediaHelloBytes - 5) throw new Error("A media ticket is 32 bytes");
  const hello = new Uint8Array(mediaHelloBytes);
  new DataView(hello.buffer).setUint32(0, mediaHelloMagic);
  hello[4] = mediaHelloVersion;
  hello.set(bytes, 5);
  bytes.fill(0);
  return hello;
}

/** The hello a relay stream with the `media` purpose opens with (D2). */
export function relayMediaHello(device: { deviceId: string; token: string }, ticket: string) {
  return {
    type: "hello",
    channel: "media",
    protocolVersion: 1,
    deviceId: device.deviceId,
    token: device.token,
    mediaTicket: ticket,
  } as const;
}

export type MediaTestClientOptions = {
  /** Called with every binary message, in order. */
  onPiece?: (piece: Uint8Array, at: number) => void;
  /** The clock pieces are stamped with; `performance.now` unless a test says. */
  now?: () => number;
};

export class MediaTestClient {
  readonly connection: string;
  readonly #socket: WebSocket;
  readonly #closed: Promise<number>;
  readonly pongs: (() => void)[] = [];
  /** Bytes received in binary messages. */
  bytes = 0;

  private constructor(socket: WebSocket, connection: string, closed: Promise<number>) {
    this.#socket = socket;
    this.connection = connection;
    this.#closed = closed;
  }

  /**
   * Opens the connection a grant names and presents its ticket. Resolves once ace-media
   * welcomes it; rejects with the close code when it refuses.
   */
  static open(
    grant: Pick<MediaConnectGranted, "url" | "ticket">,
    options: MediaTestClientOptions = {},
  ): Promise<MediaTestClient> {
    const url = grant.url;
    if (!url) throw new Error("This grant reaches the client only through the relay");
    const now = options.now ?? (() => performance.now());
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let client: MediaTestClient | undefined;
    const { promise: closed, resolve: closedWith } = Promise.withResolvers<number>();
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => socket.send(mediaHello(grant.ticket)));
      socket.addEventListener("close", (event) => {
        closedWith(event.code);
        if (!client) reject(new Error(`media connection closed: ${event.code}`));
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (!client) return;
          client.bytes += event.data.byteLength;
          options.onPiece?.(new Uint8Array(event.data), now());
          return;
        }
        const parsed = MediaStreamServerMessage.safeParse(JSON.parse(String(event.data)));
        if (!parsed.success) return;
        if (parsed.data.type === "media.welcome" && !client) {
          client = new MediaTestClient(socket, parsed.data.connection, closed);
          resolve(client);
        } else if (parsed.data.type === "pong") {
          client?.pongs.shift()?.();
        }
      });
    });
  }

  /** An ack, a ping, or anything else (to test what a media connection refuses). */
  send(message: MediaStreamClientMessage | Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(message));
  }

  /** Round trip of one ping, in ms. */
  ping(rttMs?: number): Promise<number> {
    const started = performance.now();
    return new Promise((resolve) => {
      this.pongs.push(() => resolve(performance.now() - started));
      this.send(rttMs === undefined ? { type: "ping" } : { type: "ping", rttMs });
    });
  }

  /** The close code, once the connection closes. */
  closed(): Promise<number> {
    return this.#closed;
  }

  close(): void {
    this.#socket.close();
  }
}
