import { ClientError, type ClientCore } from "@ace/client";
import { MediaConnection, type OpenMediaSocket } from "@ace/client/media";
import type { MediaRoute } from "@ace/browser/live-view";
import { nativeMediaSocket } from "./socket.ts";
import { nativeVideoCodecs } from "./video-codecs.ts";

/*
 * The phone's media connection (ADR 0147 §4): the shared `MediaConnection` on a native socket,
 * one per main session. A new main session (a reconnect, another route to the machine) gets a
 * new one, and the live views follow its binding and subscribe again. Its pictures never enter
 * JavaScriptCore: Swift assembles and draws them as it does the daemon socket's, so `onStream`
 * hears nothing here. Acks and pings leave by it while it is open.
 */

export type PhoneMediaOwner = Pick<ClientCore, "request" | "connectionGeneration">;

export interface PhoneMediaOptions {
  socket?: OpenMediaSocket;
  schedule(run: () => void, ms: number): () => void;
  /** A monotonic clock in ms (`host.monotonicMs`). */
  now(): number;
  /** The decoders this phone has, best first; HEVC only where the hardware decodes it. */
  codecs?: () => readonly string[];
}

export interface PhoneMedia {
  readonly connection: MediaConnection;
  /** What the live views name in their subscribes and send their acks by. */
  readonly route: MediaRoute;
  stop(): void;
}

/** Codes a lost main socket answers with: worth asking again soon. Anything else stands. */
const transient = new Set<string>(["offline", "timeout", "aborted", "stale", "busy", "limit"]);

/** Swift's socket as the shared connection takes it: text as text, the hello as bytes. */
export const nativeOpenMediaSocket: OpenMediaSocket = (url, events) => {
  const socket = nativeMediaSocket(url);
  socket.open({
    open: () => events.open(),
    message: (text) => events.message(text),
    binary: (bytes) => events.message(bytes),
    close: (code) => events.close(code),
  });
  return {
    send: (data) => (typeof data === "string" ? socket.send(data) : socket.sendBytes(data)),
    close: () => socket.close(),
  };
};

export function phoneMedia(owner: PhoneMediaOwner, options: PhoneMediaOptions): PhoneMedia {
  const connection = new MediaConnection({
    // A daemon that refuses the request outright (an older build) has no media connection; that
    // answer stands like `unavailable`, and delivery stays on the main socket.
    connect: () =>
      owner.request({ type: "media.connect" }).catch((error: unknown) => {
        if (error instanceof ClientError && transient.has(error.code)) throw error;
        return { refused: true };
      }),
    socket: options.socket ?? nativeOpenMediaSocket,
    schedule: options.schedule,
    now: options.now,
  });
  const codecs = options.codecs ?? nativeVideoCodecs;
  const route: MediaRoute = {
    binding: () => connection.binding(),
    codecs,
    watch: (listener) => connection.watch(listener),
    onStream: (listener) => connection.onStream(listener),
    ack: (message) => connection.ack(message),
  };
  const generation = owner.connectionGeneration();
  let current = generation.getSnapshot();
  const follow = () => (current === undefined ? connection.stop() : connection.start());
  const stopFollowing = generation.subscribe(() => {
    const next = generation.getSnapshot();
    if (next === current) return;
    current = next;
    follow();
  });
  follow();
  return {
    connection,
    route,
    stop() {
      stopFollowing();
      connection.stop();
    },
  };
}
