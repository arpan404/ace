import type { EgressRouter, EgressUnit, LegacyConsumers } from "./egress.ts";
import type { SourceKind, SourceRoute } from "./routes.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * The daemon's sources in ace-media whose producers stream into its ingest (E4 and its
 * siblings): it opens each in ace-media with a fresh single-use token and an egress handle,
 * tells the producer where to stream (`target`), and points the producer back at the daemon
 * the moment its route does or ace-media goes away. The daemon's state is the truth: after
 * every ace-media start, `replay` opens every source again with a new token.
 *
 * A route flip loses no frame: a producer sends each frame one way only, and a source whose
 * producer was just pointed back at the daemon keeps its egress (`draining`) until ace-media
 * reports the producer's end, so units already on their way still reach the consumers.
 */

type Origin = Extract<ToMedia, { type: "source.open" }>["origin"];
type EncodeSpec = Extract<ToMedia, { type: "source.encodes" }>["encodes"][number];
type Status = Extract<FromMedia, { type: "source.status" }>;

/** Where a producer streams: ace-media's loopback WebSocket ingest, with its source's token. */
export type IngestTarget = {
  url: string;
  /** The ingest socket, for producers on this machine that can use it. */
  socket: string;
  token: Uint8Array;
  epoch: number;
};

export interface MediaSourceListener {
  /** Stream to ace-media now, or (undefined) back to the daemon. */
  target(target: IngestTarget | undefined): void;
  /** One unit back on egress, for the daemon's legacy consumers. */
  unit(unit: EgressUnit): void;
  /** ace-media ended the source (`encoder-unavailable`, `reader-unavailable`, ...). */
  ended?(reason: string | undefined): void;
  status?(status: Status): void;
  keyframe?(encode: number): void;
}

export type MediaSourcesOptions = {
  /** `MediaSupervisor.send`: false while ace-media isn't up. */
  send: (message: ToMedia, payload?: Uint8Array) => boolean;
  /** `MediaSupervisor.ingest`: the running process's ingest addresses. */
  ingest: () => { socket: string; websocketPort: number } | undefined;
  /** `MediaSupervisor.need`: starts ace-media; the release lets it idle. */
  need: () => () => void;
  /** The kind's current route (`RouteWatch.routes()[kind]`). */
  route: (kind: SourceKind) => SourceRoute;
  /**
   * The settings would route this kind through ace-media once it is healthy: its sources keep
   * ace-media wanted (started, or restarted) even while their route is still the daemon's.
   */
  wanted: (kind: SourceKind) => boolean;
  egress: EgressRouter;
  randomBytes: (length: number) => Uint8Array;
  id: () => string;
  /** Delay for a draining source that never reports its producer's end. */
  setTimeout: (callback: () => void, ms: number) => () => void;
};

/** How long a source stays draining at most after its producer was sent back to the daemon. */
export const drainMs = 2_000;
/**
 * After the producer's end: its last units travel on the egress lane, which status messages
 * may overtake, so the handle stays open this much longer.
 */
export const drainGraceMs = 250;

type Open = {
  kind: SourceKind;
  origin: Origin;
  ids: { threadId?: string; tabId?: string };
  listener: MediaSourceListener;
  epoch: number;
  encodes: EncodeSpec[] | undefined;
  /** The source's id and handle in the running ace-media, while it is open there. */
  live: { id: string; handle: number } | undefined;
  /** The producer streams to ace-media now. */
  streaming: boolean;
  release: (() => void) | undefined;
  closed: boolean;
};

type Draining = {
  id: string;
  handle: number;
  kind: SourceKind;
  cancel: () => void;
  /** The source's need of ace-media, held until the drain ends. */
  release: (() => void) | undefined;
};

export class MediaSource {
  readonly #sources: MediaSources;
  readonly #open: Open;
  constructor(sources: MediaSources, open: Open) {
    this.#sources = sources;
    this.#open = open;
  }
  get kind(): SourceKind {
    return this.#open.kind;
  }
  /** The producer streams to ace-media now. */
  streaming(): boolean {
    return this.#open.streaming;
  }
  /** For a JPEG source: the encodes ace-media runs for it. */
  encodes(encodes: EncodeSpec[]): void {
    this.#open.encodes = encodes;
    const live = this.#open.live;
    if (live) this.#sources.send({ type: "source.encodes", source: live.id, encodes });
  }
  /** For a JPEG source: the encode's next unit is a keyframe. */
  key(encode: number): void {
    const live = this.#open.live;
    if (live) this.#sources.send({ type: "source.key", source: live.id, encode });
  }
  /** For a JPEG source: one screencast picture, its base64 text as the browser sent it. */
  picture(base64: string, ageMs = 0): boolean {
    const live = this.#open.live;
    if (!live || !this.#open.streaming) return false;
    const text = new TextEncoder().encode(base64);
    return this.#sources.send(
      { type: "source.picture", source: live.id, ageMs, epoch: this.#open.epoch },
      text,
    );
  }
  close(): void {
    this.#sources.close(this.#open);
  }
}

export class MediaSources {
  readonly #options: MediaSourcesOptions;
  readonly #open = new Set<Open>();
  readonly #byId = new Map<string, Open>();
  readonly #draining = new Map<string, Draining>();

  constructor(options: MediaSourcesOptions) {
    this.#options = options;
  }

  /**
   * A source whose producer can stream into ace-media. It is opened there while its kind's
   * route says so; the listener hears each change of target.
   */
  open(
    kind: SourceKind,
    origin: Origin,
    listener: MediaSourceListener,
    ids: { threadId?: string; tabId?: string } = {},
  ): MediaSource {
    const open: Open = {
      kind,
      origin,
      ids,
      listener,
      epoch: 0,
      encodes: undefined,
      live: undefined,
      streaming: false,
      release: undefined,
      closed: false,
    };
    this.#open.add(open);
    this.#apply(open);
    return new MediaSource(this, open);
  }

  /** Whether a kind's producers stream into ace-media now. */
  routed(kind: SourceKind): boolean {
    return this.#options.route(kind).producer === "ace-media";
  }

  /**
   * The route as egress dispatch must read it: a kind keeps its egress while one of its
   * sources drains, so units a producer sent before it was pointed back still arrive.
   */
  egressRoute(kind: SourceKind): SourceRoute {
    const route = this.#options.route(kind);
    if (route.egress) return route;
    for (const draining of this.#draining.values())
      if (draining.kind === kind) return { ...route, egress: true };
    return route;
  }

  /** Routes changed for these kinds: move their producers. */
  routesChanged(kinds: readonly SourceKind[]): void {
    for (const open of this.#open) if (kinds.includes(open.kind)) this.#apply(open);
  }

  /** ace-media is up (the supervisor's `replay`): every source opens again with a new token. */
  replay(): void {
    for (const open of this.#open) {
      this.#forget(open, false);
      this.#apply(open);
    }
  }

  /** ace-media went away: every producer streams to the daemon until it is back. */
  exited(): void {
    for (const draining of this.#draining.values()) this.#endDrain(draining.id);
    for (const open of this.#open) this.#forget(open);
  }

  /** A message from ace-media; the ones about sources are handled here. */
  message(message: FromMedia): void {
    if (message.type === "source.status") return this.#status(message);
    if (message.type === "source.keyframe") {
      this.#byId.get(message.source)?.listener.keyframe?.(message.encode);
    }
  }

  send(message: ToMedia, payload?: Uint8Array): boolean {
    return this.#options.send(message, payload);
  }

  close(open: Open): void {
    if (open.closed) return;
    open.closed = true;
    this.#open.delete(open);
    this.#retire(open, false);
    open.release?.();
    open.release = undefined;
  }

  #status(message: Status): void {
    const draining = this.#draining.get(message.source);
    if (draining) {
      if (message.status === "ended" || message.status === "retrying") {
        draining.cancel();
        draining.cancel = this.#options.setTimeout(
          () => this.#endDrain(message.source),
          drainGraceMs,
        );
      }
      return;
    }
    const open = this.#byId.get(message.source);
    if (!open) return;
    open.listener.status?.(message);
    if (message.status === "retrying") {
      // Tokens are single use: a producer that lost its connection needs a new one.
      this.#forget(open, false);
      this.#apply(open);
    } else if (message.status === "ended") {
      this.#forget(open);
      open.listener.target(undefined);
      open.listener.ended?.(message.reason);
    }
  }

  /** Opens or retires the source in ace-media to match its kind's route. */
  #apply(open: Open): void {
    if (open.closed) return;
    if (this.#options.wanted(open.kind)) open.release ??= this.#options.need();
    if (!this.routed(open.kind)) return this.#retire(open, true);
    if (open.live) return;
    const ingest = this.#options.ingest();
    if (!ingest) return; // Not up yet: `replay` opens it.
    const id = this.#options.id();
    const consumers: LegacyConsumers = {
      deliver: (unit) => open.listener.unit(unit),
      record: () => {},
      still: () => {},
    };
    const handle = this.#options.egress.open(id, open.kind, consumers);
    const token = this.#options.randomBytes(32);
    const opened = this.#options.send(
      {
        type: "source.open",
        source: id,
        handle,
        epoch: open.epoch,
        origin: open.origin,
        ...(open.ids.threadId === undefined ? {} : { threadId: open.ids.threadId }),
        ...(open.ids.tabId === undefined ? {} : { tabId: open.ids.tabId }),
      },
      token.slice(),
    );
    if (!opened) {
      this.#options.egress.close(handle);
      token.fill(0);
      return;
    }
    open.live = { id, handle };
    this.#byId.set(id, open);
    if (this.#options.route(open.kind).egress)
      this.#options.send({ type: "source.egress", source: id, on: true });
    if (open.encodes) this.#options.send({ type: "source.encodes", source: id, encodes: open.encodes });
    open.streaming = true;
    open.listener.target({
      url: `ws://127.0.0.1:${ingest.websocketPort}/ingest`,
      socket: ingest.socket,
      token,
      epoch: open.epoch,
    });
  }

  /**
   * The producer goes back to the daemon. With `drain`, the source stays open in ace-media
   * until its producer's end arrives (or `drainMs`), so its last units still come back.
   */
  #retire(open: Open, drain: boolean): void {
    const live = open.live;
    const streaming = open.streaming;
    open.live = undefined;
    open.streaming = false;
    if (live) this.#byId.delete(live.id);
    if (streaming) open.listener.target(undefined);
    if (!live) {
      if (drain && !this.#options.wanted(open.kind)) {
        open.release?.();
        open.release = undefined;
      }
      return;
    }
    if (drain) {
      const cancel = this.#options.setTimeout(() => this.#endDrain(live.id), drainMs);
      const wanted = this.#options.wanted(open.kind);
      const release = wanted ? undefined : open.release;
      if (!wanted) open.release = undefined;
      this.#draining.set(live.id, { ...live, kind: open.kind, cancel, release });
      return;
    }
    this.#options.egress.close(live.handle);
    this.#options.send({ type: "source.close", source: live.id });
  }

  #endDrain(id: string): void {
    const draining = this.#draining.get(id);
    if (!draining) return;
    this.#draining.delete(id);
    draining.cancel();
    draining.release?.();
    this.#options.egress.close(draining.handle);
    this.#options.send({ type: "source.close", source: id });
  }

  /**
   * The running process's state for `open` is gone (it exited, or is reopened). With `notify`,
   * the producer is pointed back at the daemon; a reopen gives it the new target instead.
   */
  #forget(open: Open, notify = true): void {
    const live = open.live;
    if (live) {
      this.#byId.delete(live.id);
      this.#options.egress.close(live.handle);
      this.#options.send({ type: "source.close", source: live.id });
    }
    open.live = undefined;
    if (!open.streaming) return;
    open.streaming = false;
    if (notify) open.listener.target(undefined);
  }
}
