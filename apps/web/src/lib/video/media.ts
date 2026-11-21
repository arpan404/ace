import { ClientError, type ClientApi } from "@ace/client";
import {
  browserMediaSocket,
  MediaConnection,
  type OpenMediaRelay,
  type OpenMediaSocket,
  unavailableReason,
} from "@ace/client/media";
import type { MediaRoute } from "@ace/browser/live-view";
import { webCodecsSupport, within, type VideoSupport } from "./codecs.ts";

/*
 * The web client's media connection (ADR 0147 §4): one per daemon connection, opened the first
 * time a live view needs it and kept with that connection. A new socket to the daemon (a
 * reconnect, a move to another path) is a new main session, so it gets a new media connection;
 * views follow the binding and subscribe again.
 */

export interface WebMedia {
  readonly connection: MediaConnection;
  /** What the screen and device channels take (`useMedia`). */
  readonly route: MediaRoute;
  /**
   * How this client reaches the daemon through the relay, from whichever view knows its
   * endpoint; a grant without a `url` opens a relay stream with it, and is unavailable without.
   */
  relayWith(open: OpenMediaRelay | undefined): void;
}

export interface WebMediaOptions {
  socket?: OpenMediaSocket;
  schedule?: (run: () => void, ms: number) => () => void;
  now?: () => number;
  /** Which codecs this client decodes; omitted: asks WebCodecs. */
  support?: VideoSupport;
}

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** Device and screen pictures are H.264 or HEVC access units (`stream-picture.ts`). */
const pictureCodec = /^(?:hvc1|hev1|avc1)\./;

const transient = new Set<string>(["offline", "timeout", "aborted", "stale", "busy", "limit"]);

const media = new WeakMap<ClientApi, WebMedia>();

/** The client's media connection, opened for its current socket on first use. */
export function mediaFor(client: ClientApi, options: WebMediaOptions = {}): WebMedia {
  const known = media.get(client);
  if (known) return known;
  const later = options.schedule ?? schedule;
  let relay: OpenMediaRelay | undefined;
  const connection = new MediaConnection({
    relay: () => relay,
    // A daemon that refuses the request outright (an older build) has no media connection: that
    // answer stands like `unavailable`. Only a lost socket is worth asking again soon.
    connect: () =>
      client.request({ type: "media.connect" }).catch((error: unknown) => {
        if (error instanceof ClientError && transient.has(error.code)) throw error;
        return { refused: true };
      }),
    socket: options.socket ?? browserMediaSocket,
    schedule: later,
    now: options.now ?? (() => performance.now()),
  });
  let codecs: readonly string[] = [];
  void within((options.support ?? webCodecsSupport)(), 1_000, [], later).then((supported) => {
    codecs = supported.filter((codec) => pictureCodec.test(codec));
  });
  const route: MediaRoute = {
    binding: () => connection.binding(),
    codecs: () => codecs,
    watch: (listener) => connection.watch(listener),
    onStream: (listener) => connection.onStream(listener),
    ack: (message) => connection.ack(message),
    unavailable: () => unavailableReason(connection.state),
  };
  const made: WebMedia = {
    connection,
    route,
    relayWith: (open) => {
      relay = open;
    },
  };
  media.set(client, made);
  try {
    const socket = client.connectionGeneration();
    let current = socket.getSnapshot();
    const follow = () => (current === undefined ? connection.stop() : connection.start());
    socket.subscribe(() => {
      const next = socket.getSnapshot();
      if (next === current) return;
      current = next;
      follow();
    });
    follow();
  } catch {
    // A closed client: there is no main session to ask.
  }
  return made;
}
