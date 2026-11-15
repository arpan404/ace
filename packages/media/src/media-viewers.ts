import type { MediaLinkHint, MediaSubscribed } from "@ace/protocol";
import type { IngestProducer } from "./ingest-sources.ts";
import type { MediaConnections } from "./media-connections.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/*
 * Views ace-media delivers (D1), held by the daemon. A subscribe naming a media connection
 * becomes an intent: which producer's pictures, for which client ids, at what viewport. It is
 * granted to ace-media (`viewer.open`) under the producer's current id there, and granted again
 * under the new one whenever that changes (a route flip, a reopen), so the view follows its
 * source. ace-media holds nothing across restarts; an intent ends with its media connection.
 *
 * The poster (ADR 0149): the subscribe's reply carries a viewport-sized still of 10–20 KB from
 * ace-media's poster path (`still.poster`), when the source already has a picture.
 */

type ViewerOpen = Extract<ToMedia, { type: "viewer.open" }>;
export type ViewTarget = ViewerOpen["target"];
export type ViewViewport = ViewerOpen["viewport"];

export type ViewIntent = {
  viewer: string;
  session: string;
  connection: string;
  target: ViewTarget;
  codecs: string[];
  viewport: ViewViewport;
  local: boolean;
  audio: boolean;
  link?: ViewerOpen["link"];
  /** Whether a producer's pictures are this view's. */
  shows: (producer: IngestProducer) => boolean;
};

export type MediaPosterBytes = { width: number; height: number; jpeg: Uint8Array };

export type MediaViewersOptions = {
  connections: MediaConnections;
  /** The producers streaming into ace-media now (`IngestSources.live`). */
  live: () => { producer: IngestProducer; path: string }[];
  send: (message: ToMedia) => boolean;
  id: () => string;
  schedule: (callback: () => void, ms: number) => () => void;
  /** A monotonic clock in ms, for the poster's budget. */
  now: () => number;
};

/**
 * How long a subscribe reply waits for its poster. A first viewer's subscribe opens the capture,
 * so the budget covers the source starting and its first picture (ADR 0149: about 1 s on 3G).
 */
export const posterDeadlineMs = 1_000;
const posterRetryMs = 50;

type Held = { intent: ViewIntent; path: string | undefined };
type Waiting = { done: (answer: MediaPosterBytes | "wait" | "gone") => void; cancel: () => void };
/** Still failures that mean the source has no picture yet: worth asking again. */
const notYet = new Set(["no-source", "no-picture"]);

export class MediaViewers {
  readonly #options: MediaViewersOptions;
  readonly #held = new Map<string, Held>();
  readonly #posters = new Map<string, Waiting>();

  constructor(options: MediaViewersOptions) {
    this.#options = options;
  }

  /**
   * A subscribe naming `intent.connection`. False when that connection isn't the session's: the
   * caller refuses the subscribe. True even before the producer streams into ace-media: the
   * view is granted once it does.
   */
  bind(intent: ViewIntent): boolean {
    if (!this.#options.connections.owned(intent.session, intent.connection)) return false;
    const held: Held = { intent, path: undefined };
    this.#held.set(intent.viewer, held);
    const live = this.#options.live().find((entry) => intent.shows(entry.producer));
    if (live) this.#grant(held, live.path);
    return true;
  }

  /** Whether the view is granted under a producer streaming into ace-media now. */
  granted(viewer: string): boolean {
    return this.#held.get(viewer)?.path !== undefined;
  }

  #grant(held: Held, path: string): void {
    const { intent } = held;
    const granted = this.#options.connections.view(intent.session, intent.connection, {
      viewer: intent.viewer,
      source: path,
      target: intent.target,
      codecs: intent.codecs,
      viewport: intent.viewport,
      local: intent.local,
      audio: intent.audio,
      ...(intent.link ? { link: intent.link } : {}),
    });
    held.path = granted ? path : undefined;
  }

  configure(viewer: string, viewport: ViewViewport, audio: boolean): void {
    const held = this.#held.get(viewer);
    if (!held) return;
    held.intent = { ...held.intent, viewport, audio };
    if (held.path) this.#options.send({ type: "viewer.configure", viewer, viewport, audio });
  }

  pause(viewer: string, paused: boolean): void {
    if (this.#held.get(viewer)?.path)
      this.#options.send({ type: paused ? "viewer.pause" : "viewer.resume", viewer });
  }

  unbind(viewer: string): void {
    const held = this.#held.get(viewer);
    if (!held) return;
    this.#held.delete(viewer);
    if (held.path) this.#options.send({ type: "viewer.close", viewer });
  }

  /** `IngestSources.onLive`: views of this producer move to its new id. */
  live(producer: IngestProducer, path: string | undefined): void {
    for (const held of this.#held.values()) {
      if (!held.intent.shows(producer)) continue;
      if (path === undefined) held.path = undefined;
      else if (held.path !== path) this.#grant(held, path);
    }
  }

  /**
   * The viewer's poster: once the view is granted and its source has a picture, within
   * `posterDeadlineMs`; undefined when that takes longer.
   */
  async poster(viewer: string): Promise<MediaPosterBytes | undefined> {
    const until = this.#options.now() + posterDeadlineMs;
    for (;;) {
      const left = until - this.#options.now();
      if (left <= 0 || !this.#held.has(viewer)) return undefined;
      const held = this.#held.get(viewer);
      const answer = held?.path ? await this.#ask(held, Math.round(left)) : "wait";
      if (typeof answer === "object") return answer;
      if (answer === "gone") return undefined;
      await new Promise<void>((resolve) => this.#options.schedule(resolve, posterRetryMs));
    }
  }

  /** One `still.poster`: the poster, "wait" when the source has no picture yet, else "gone". */
  #ask(held: Held, deadlineMs: number): Promise<MediaPosterBytes | "wait" | "gone"> {
    const request = this.#options.id();
    const { viewport } = held.intent;
    const dpr = Math.min(Math.max(viewport.dpr, 1), 3);
    const sent = this.#options.send({
      type: "still.poster",
      request,
      source: held.path ?? "",
      width: Math.max(2, Math.round(viewport.width * dpr)),
      height: Math.max(2, Math.round(viewport.height * dpr)),
      deadlineMs,
    });
    if (!sent) return Promise.resolve("gone");
    return new Promise((resolve) => {
      const cancel = this.#options.schedule(() => {
        this.#posters.delete(request);
        resolve("gone");
      }, deadlineMs + 200);
      this.#posters.set(request, { done: resolve, cancel });
    });
  }

  /** ace-media's messages: poster answers, and connections that closed. */
  received(message: FromMedia, payload: Uint8Array): void {
    if (message.type === "still.done" || message.type === "still.failed") {
      const waiting = this.#posters.get(message.request);
      if (!waiting) return;
      this.#posters.delete(message.request);
      waiting.cancel();
      waiting.done(
        message.type === "still.done"
          ? { width: message.width, height: message.height, jpeg: payload.slice() }
          : notYet.has(message.reason)
            ? "wait"
            : "gone",
      );
    } else if (message.type === "connection.closed") {
      for (const [viewer, held] of this.#held)
        if (held.intent.connection === message.connection) this.#held.delete(viewer);
    }
  }

  /** ace-media exited: every view went with its connection. */
  exited(): void {
    this.#held.clear();
    for (const waiting of this.#posters.values()) {
      waiting.cancel();
      waiting.done("gone");
    }
    this.#posters.clear();
  }
}

/** What a bridge needs of the daemon's delivery to bind subscribes (browser, screen, devices). */
export type MediaDeliveryPort = {
  /** Whether ace-media delivers this kind's viewers now (setting, health and route). */
  serves(kind: import("./routes.ts").SourceKind): boolean;
  bind(intent: ViewIntent): boolean;
  granted(viewer: string): boolean;
  poster(viewer: string): Promise<MediaPosterBytes | undefined>;
  configure(viewer: string, viewport: ViewViewport, audio: boolean): void;
  pause(viewer: string, paused: boolean): void;
  unbind(viewer: string): void;
};

/** A client's viewport in ace-media's terms. */
export function viewViewport(viewport: {
  width: number;
  height: number;
  devicePixelRatio: number;
}): ViewViewport {
  const whole = (n: number) => Math.max(1, Math.min(0xffffffff, Math.round(n)));
  return {
    width: whole(viewport.width),
    height: whole(viewport.height),
    dpr: viewport.devicePixelRatio,
    scale: 1,
  };
}

/**
 * The client's parsed link hint for `viewer.open`, built field by field (the wire's is strict, so
 * a newer client's extra field never fails the grant).
 */
export function viewLink(hint: MediaLinkHint | undefined): ViewerOpen["link"] {
  if (!hint) return undefined;
  const link: NonNullable<ViewerOpen["link"]> = {};
  if (hint.effectiveType !== undefined) link.effectiveType = hint.effectiveType.slice(0, 64);
  if (hint.downlinkKbps !== undefined) link.downlinkKbps = hint.downlinkKbps;
  if (hint.rttMs !== undefined) link.rttMs = hint.rttMs;
  if (hint.saveData !== undefined) link.saveData = hint.saveData;
  if (hint.expensive !== undefined) link.expensive = hint.expensive;
  if (hint.constrained !== undefined) link.constrained = hint.constrained;
  return Object.keys(link).length ? link : undefined;
}

/** The subscribe reply's `media`: the connection, and the poster when there is one. */
export function mediaSubscribed(
  connection: string,
  poster: MediaPosterBytes | undefined,
): MediaSubscribed {
  if (!poster || poster.jpeg.length === 0 || poster.jpeg.length > 48 * 1024) return { connection };
  return {
    connection,
    poster: {
      width: poster.width,
      height: poster.height,
      jpeg: Buffer.from(poster.jpeg).toString("base64"),
    },
  };
}
