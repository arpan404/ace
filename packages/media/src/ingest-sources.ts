import type { AccelerationSubject, SourceAcceleration } from "./acceleration.ts";
import type { EgressRouter, LegacyConsumers } from "./egress.ts";
import {
  sourceRoute,
  type MediaRoutes,
  type RouteCapabilities,
  type SourceKind,
  type SourceRoute,
} from "./routes.ts";
import type { MediaSettings } from "./supervision-policy.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * Producers that stream into ace-media's ingest (docs/media/plan.md, phase 2, E1–E4): the
 * daemon's side, one for every kind (browser tabs, screens, devices). ace-media is the only
 * path a producer has. While a kind's route says `producer: "ace-media"`, each producer's source
 * is opened in ace-media with a fresh id, single-use token and egress handle, and once ace-media
 * reports it `starting` the producer is pointed at the ingest. When the route stops it (ace-media
 * restarting or unavailable) the producer is told to stop streaming, and its handle keeps
 * delivering until ace-media's end marker for it arrives on egress, after its last unit. The
 * handle closes only then; a marker that never comes within `drainMs` is reported as a cut path,
 * never as a clean one. The daemon's state is the truth: every ace-media start opens each source
 * again, including one whose earlier opens failed.
 */

export type Origin = Extract<ToMedia, { type: "source.open" }>["origin"];
type EncodeSpec = Extract<ToMedia, { type: "source.encodes" }>["encodes"][number];
type Status = Extract<FromMedia, { type: "source.status" }>;

/** Where a producer sends: ace-media's ingest (socket, or loopback WebSocket) with its token. */
export type IngestAddress = {
  url: string;
  socket: string;
  token: Uint8Array;
  epoch: number;
  /**
   * The ace-media process serving `socket`. A Windows producer refuses a named pipe served by
   * any other process: another instance of the name can be created by any process of this
   * user.
   */
  pid?: number;
  /** This open's id in ace-media: the path's name in a merge, and `EgressUnit.source` of its
   * units. */
  path: string;
};

export type IngestProducer = {
  /** The daemon's name for the producer; ace-media's id for it is new on every open. */
  source: string;
  kind: SourceKind;
  origin: Origin;
  threadId?: string;
  tabId?: string;
  sessionId?: string;
  deviceId?: string;
  /** The privacy epoch the producer stamps now. */
  epoch: () => number;
  /** The daemon's legacy consumers of this source, fed from egress. */
  consumers: LegacyConsumers;
  /**
   * Points the producer at ace-media (an address), or stops it streaming (undefined): it has no
   * other path. Resolves once the producer has switched; a rejection keeps this source stopped
   * until its route changes or ace-media starts again.
   */
  point: (address: IngestAddress | undefined) => Promise<void>;
  /** ace-media's egress dropped deltas or a consumer needs one: a keyframe of this encode. */
  keyframe: (encode: number) => void;
  /**
   * The ace-media path `path` ended: every unit it carried has arrived (`interrupted` false),
   * or it was cut and units may be missing. Always after the `point` that left it.
   */
  pathEnded?: (path: string, interrupted: boolean) => void;
  /**
   * ace-media ended the source with a reason, or its opens kept failing: it stays stopped until
   * its route changes or ace-media starts again. Its live views say why.
   */
  refused?: (reason: string | undefined) => void;
  /**
   * The source's video stopped and won't come back on its own soon (ace-media exited, is
   * unavailable, or kept failing it): why, for its live views. The next `point` with an address
   * means it streams again.
   */
  stopped?: (reason: string) => void;
  /**
   * The privacy epochs this producer stamped that the daemon knows were clear: the source was
   * public for all of each one. A poster shows a picture only from these (D1). Absent: none, so
   * no poster (a producer that can't vouch for its source's privacy history gets none).
   */
  clearEpochs?: () => [number, number][];
  /**
   * ace-media's plan for the views it delivers (`source.want`, D1): the encodes to run, under
   * ace-media's own ids. Sent only while this producer streams to ace-media.
   */
  want?: (encodes: EncodeSpec[]) => void;
};

/** What the sources need of the supervisor. */
export type IngestPort = {
  send: (message: ToMedia, payload?: Uint8Array) => boolean;
  ingest: () => { socket: string; websocketPort: number; pid?: number } | undefined;
  need: () => () => void;
};

export type IngestSourcesOptions = {
  port: IngestPort;
  router: EgressRouter;
  /** The daemon's current table (`RouteWatch.routes()`). */
  routes: () => MediaRoutes;
  /** The settings and capabilities the table comes from: which sources want ace-media running
   * while it restarts. */
  settings: () => MediaSettings;
  capabilities: () => RouteCapabilities;
  randomBytes: (length: number) => Uint8Array;
  id: () => string;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /**
   * Why sources can't stream now, while ace-media is restarting or unavailable; undefined while
   * it is only starting (a source then waits without a word).
   */
  why?: () => string | undefined;
  /**
   * A producer's open in ace-media changed: its id there now, or none. Viewers delivered by
   * ace-media follow it (D1).
   */
  onLive?: (producer: IngestProducer, path: string | undefined) => void;
  /** A source's `source.status.acceleration`; undefined once its path ends. */
  acceleration?: (
    subject: AccelerationSubject,
    acceleration: SourceAcceleration | undefined,
  ) => void;
};

/**
 * What a producer that encodes only H.264 tells ace-media (`IngestSource.codecs`): the screen
 * helpers and the devices. ace-media plans a view that prefers HEVC onto it, as H.264.
 */
export const h264Only: readonly string[] = ["avc1.42E033"];

/** Reconnects after the producer's connection ended, before the source stays stopped. */
export const maxIngestReopens = 3;
/** What a source's views say when ace-media stopped and gave no reason of its own. */
export const restartingReason = "ace-media stopped and is starting again";
/** What they say when ace-media kept failing the source. */
export const failedReason = "ace-media couldn't take this video";

/** Longest a handle waits for its end marker after its producer was pointed away. */
export const drainMs = 2_000;

/**
 * Kinds ace-media reads itself: pictures from the control lane, and a Simulator's serve-sim
 * stream, which it opens. Only ace-media's close ends their reading, so leaving closes them
 * there at once; the end marker follows the last unit.
 */
const readByMedia: ReadonlySet<SourceKind> = new Set<SourceKind>([
  "tab-pictures",
  "user-tab",
  "simulator",
]);

type Entry = {
  producer: IngestProducer;
  /** `off`: not streaming anywhere (ace-media isn't up, or the source failed there). */
  state: "off" | "opening" | "ingest";
  /** The open in the running ace-media, while there is one. */
  live: Path | undefined;
  /** Keeps ace-media running while settings want this source there, through restarts. */
  release: (() => void) | undefined;
  encodes: EncodeSpec[] | undefined;
  /** What the producer encodes (`source.codecs`), told to every open. */
  codecs: string[] | undefined;
  /** Bumped by every switch, so a late answer to an older one is ignored. */
  generation: number;
  /** Ingest failed or was refused: it stays off until its route changes or ace-media restarts. */
  failed: boolean;
  reopens: number;
  closed: boolean;
  /** The path whose acceleration report stands for this source. */
  acceleratedBy?: string | undefined;
};

/** One open in ace-media: an id, its token until pointed, and its egress handle. */
type Path = {
  entry: Entry;
  id: string;
  handle: number;
  token: Uint8Array | undefined;
  route: SourceRoute;
  /** The producer was pointed here. */
  pointed: boolean;
  /** Its end marker came. */
  marked: { interrupted: boolean } | undefined;
  /** Retired: delivering until its marker. */
  draining: (() => void) | undefined;
  closeSent: boolean;
  /** Draining keeps ace-media's need until the path ends. */
  release: (() => void) | undefined;
  reported: boolean;
  /** ace-media's last plan for it (`source.want`), for the producer once it is pointed here. */
  want: Extract<FromMedia, { type: "source.want" }>["encodes"] | undefined;
};

export type IngestSource = {
  /** The producer streams to ace-media now. */
  streaming(): boolean;
  /** The producer's ingest connection ended (it said so): open the source again. */
  reconnect(): void;
  /**
   * The codecs the producer encodes, best first (WebCodecs strings): ace-media plans its views
   * only in these. Never called: whatever the views decode.
   */
  codecs(codecs: string[]): void;
  /** For a JPEG source: the encodes ace-media runs for it. */
  encodes(encodes: EncodeSpec[]): void;
  /** For a JPEG source: the encode's next unit is a keyframe. */
  key(encode: number): void;
  /** For a JPEG source: one screencast picture, its base64 text as the browser sent it. */
  picture(base64: string, ageMs?: number): boolean;
  close(): void;
};

export class IngestSources {
  readonly #options: IngestSourcesOptions;
  readonly #entries = new Set<Entry>();
  readonly #paths = new Map<string, Path>();

  constructor(options: IngestSourcesOptions) {
    this.#options = options;
  }

  add(producer: IngestProducer): IngestSource {
    const entry: Entry = {
      producer,
      state: "off",
      live: undefined,
      release: undefined,
      encodes: undefined,
      codecs: undefined,
      generation: 0,
      failed: false,
      reopens: 0,
      closed: false,
    };
    this.#entries.add(entry);
    this.#sync(entry);
    if (entry.state === "off") {
      const why = this.#options.why?.();
      if (why) producer.stopped?.(why);
    }
    return {
      streaming: () => entry.state === "ingest",
      reconnect: () => this.#reconnect(entry),
      codecs: (codecs) => {
        entry.codecs = [...codecs];
        const live = entry.live;
        if (live) this.#send({ type: "source.codecs", source: live.id, codecs: entry.codecs });
      },
      encodes: (encodes) => {
        entry.encodes = encodes;
        const live = entry.live;
        if (live) this.#send({ type: "source.encodes", source: live.id, encodes });
      },
      key: (encode) => {
        const live = entry.live;
        if (live) this.#send({ type: "source.key", source: live.id, encode });
      },
      picture: (base64, ageMs = 0) => {
        const live = entry.live;
        if (!live || entry.state !== "ingest") return false;
        return this.#options.port.send(
          { type: "source.picture", source: live.id, ageMs, epoch: entry.producer.epoch() },
          new TextEncoder().encode(base64),
        );
      },
      close: () => this.#close(entry),
    };
  }

  /** Whether the settings route a kind through ace-media once it is healthy. */
  wanted(kind: SourceKind): boolean {
    const { settings, capabilities } = this.#options;
    return sourceRoute(kind, settings(), "healthy", capabilities()).producer === "ace-media";
  }

  /** ace-media's ingest WebSocket now, while it runs. */
  endpoint(): string | undefined {
    const ingest = this.#options.port.ingest();
    return ingest ? `ws://127.0.0.1:${ingest.websocketPort}/ingest` : undefined;
  }

  /** Whether a kind's producers stream into ace-media now. */
  routed(kind: SourceKind): boolean {
    return this.#options.routes()[kind].producer === "ace-media";
  }

  /** `RouteWatch.onChange`: move the producers of these kinds. */
  routesChanged(kinds: readonly SourceKind[]): void {
    for (const entry of this.#entries)
      if (kinds.includes(entry.producer.kind)) {
        entry.failed = false;
        entry.reopens = 0;
        const was = entry.state;
        this.#sync(entry);
        if (was !== "off" && entry.state === "off")
          entry.producer.stopped?.(this.#options.why?.() ?? restartingReason);
      }
  }

  /** The supervisor's `replay`: ace-media is up, with a new ingest. Failed sources try again. */
  replay(): void {
    for (const entry of this.#entries) {
      entry.failed = false;
      entry.reopens = 0;
      this.#sync(entry);
    }
  }

  /** The supervisor's `onExit`: every id, token and handle of that process is gone. */
  exited(): void {
    for (const entry of this.#entries) {
      const live = entry.live;
      this.#live(entry, undefined);
      entry.generation++;
      const was = entry.state;
      entry.state = "off";
      if (was === "ingest") void entry.producer.point(undefined).catch(() => {});
      if (live) this.#finish(live, true, false);
      if (was !== "off") entry.producer.stopped?.(this.#options.why?.() ?? restartingReason);
    }
    // Deleting while iterating a Map is safe: finished paths aren't visited again.
    for (const path of this.#paths.values()) this.#finish(path, true, false);
  }

  #live(entry: Entry, path: Path | undefined): void {
    if (entry.live === path) return;
    entry.live = path;
    this.#options.onLive?.(entry.producer, path?.id);
  }

  /** The producers streaming into ace-media now, with their ids there. */
  live(): { producer: IngestProducer; path: string }[] {
    const out: { producer: IngestProducer; path: string }[] = [];
    for (const entry of this.#entries)
      if (entry.live && !entry.closed) out.push({ producer: entry.producer, path: entry.live.id });
    return out;
  }

  /** The supervisor's `onMessage`. */
  message(message: FromMedia): void {
    if (
      message.type !== "source.status" &&
      message.type !== "source.keyframe" &&
      message.type !== "source.want"
    )
      return;
    const path = this.#paths.get(message.source);
    if (!path || path.draining) return;
    const { entry } = path;
    if (entry.closed || entry.live !== path) return;
    if (message.type === "source.keyframe") {
      if (entry.state === "ingest") entry.producer.keyframe(message.encode);
      return;
    }
    if (message.type === "source.want") {
      // ace-media plans as soon as a view is granted, often before the producer is pointed
      // here: the plan is kept for then.
      path.want = message.encodes;
      if (entry.state === "ingest") entry.producer.want?.(message.encodes);
      return;
    }
    if (message.acceleration) {
      entry.acceleratedBy = path.id;
      this.#options.acceleration?.(entry.producer, message.acceleration);
    }
    this.#status(entry, path, message);
  }

  #send(message: ToMedia, payload?: Uint8Array): boolean {
    return this.#options.port.send(message, payload);
  }

  #status(entry: Entry, path: Path, message: Status): void {
    if (message.status === "starting") return this.#started(entry, path);
    if (message.status === "playing") {
      entry.reopens = 0;
      return;
    }
    if (message.status === "ended" && message.reason !== undefined) {
      entry.failed = true;
      this.#leave(entry);
      entry.producer.refused?.(message.reason);
      entry.producer.stopped?.(message.reason);
      return;
    }
    if (entry.state === "ingest") this.#reconnect(entry);
  }

  #sync(entry: Entry): void {
    if (entry.closed) return;
    const { kind } = entry.producer;
    if (this.wanted(kind)) entry.release ??= this.#options.port.need();
    else {
      entry.release?.();
      entry.release = undefined;
    }
    const route = this.#options.routes()[kind];
    const desired = route.producer === "ace-media" && !entry.failed;
    if (desired && entry.state === "off") this.#open(entry, route);
    else if (!desired && entry.state !== "off") this.#leave(entry);
    else if (desired && entry.live && entry.live.route.egress !== route.egress) {
      entry.live.route = route;
      this.#send({ type: "source.egress", source: entry.live.id, on: route.egress });
    }
  }

  #open(entry: Entry, route: SourceRoute): void {
    const { port, router, randomBytes } = this.#options;
    if (!port.ingest()) return; // Not up yet: `replay` opens it.
    const { producer } = entry;
    const id = this.#options.id();
    let path: Path | undefined;
    const consumers: LegacyConsumers = {
      ...producer.consumers,
      end: (end) => {
        if (path) this.#marked(path, end.interrupted);
      },
    };
    const handle = router.open(id, producer.kind, consumers, () =>
      path?.draining ? path.route : this.#options.routes()[producer.kind],
    );
    const token = randomBytes(32);
    const opened = port.send(
      {
        type: "source.open",
        source: id,
        handle,
        epoch: producer.epoch(),
        origin: producer.origin,
        ...(producer.threadId === undefined ? {} : { threadId: producer.threadId }),
        ...(producer.tabId === undefined ? {} : { tabId: producer.tabId }),
        ...(producer.sessionId === undefined ? {} : { sessionId: producer.sessionId }),
        ...(producer.deviceId === undefined ? {} : { deviceId: producer.deviceId }),
      },
      token.slice(),
    );
    if (!opened) {
      router.close(handle);
      token.fill(0);
      return;
    }
    path = {
      entry,
      id,
      handle,
      token,
      route,
      pointed: false,
      marked: undefined,
      draining: undefined,
      closeSent: false,
      release: undefined,
      reported: false,
      want: undefined,
    };
    this.#paths.set(id, path);
    this.#live(entry, path);
    entry.state = "opening";
    if (route.egress) this.#send({ type: "source.egress", source: id, on: true });
    if (entry.codecs) this.#send({ type: "source.codecs", source: id, codecs: entry.codecs });
    if (entry.encodes) this.#send({ type: "source.encodes", source: id, encodes: entry.encodes });
  }

  /** ace-media has the source: hand the producer its address. */
  #started(entry: Entry, path: Path): void {
    const token = path.token;
    const ingest = this.#options.port.ingest();
    if (entry.state !== "opening" || !token || !ingest) return;
    path.token = undefined;
    path.pointed = true;
    entry.state = "ingest";
    const generation = ++entry.generation;
    const address: IngestAddress = {
      url: this.endpoint() ?? "",
      socket: ingest.socket,
      token,
      epoch: entry.producer.epoch(),
      path: path.id,
      ...(ingest.pid ? { pid: ingest.pid } : {}),
    };
    const pointed = entry.producer.point(address);
    if (path.want) entry.producer.want?.(path.want);
    pointed.then(
      () => token.fill(0),
      (error: unknown) => {
        token.fill(0);
        if (entry.generation !== generation || entry.closed) return;
        this.#options.log?.("producer refused ingest", {
          source: entry.producer.source,
          error: error instanceof Error ? error.message : String(error),
        });
        entry.failed = true;
        this.#leave(entry);
        entry.producer.stopped?.(failedReason);
      },
    );
  }

  /** Stops the producer streaming; its path drains until its marker. */
  #leave(entry: Entry): void {
    const live = entry.live;
    this.#live(entry, undefined);
    entry.generation++;
    const was = entry.state;
    entry.state = "off";
    if (was === "ingest") void entry.producer.point(undefined).catch(() => {});
    if (live) this.#retire(live);
    if (!this.wanted(entry.producer.kind)) {
      entry.release?.();
      entry.release = undefined;
    }
  }

  #reconnect(entry: Entry): void {
    if (entry.closed || entry.state === "off") return;
    const live = entry.live;
    this.#live(entry, undefined);
    entry.state = "off";
    entry.generation++;
    if (live) this.#retire(live);
    if (++entry.reopens > maxIngestReopens) {
      entry.failed = true;
      void entry.producer.point(undefined).catch(() => {});
      entry.producer.stopped?.(failedReason);
      return;
    }
    // Reopened at once: the producer gets its new address.
    this.#sync(entry);
  }

  /**
   * A path no longer live. One the producer was never pointed at closes at once. Otherwise it
   * delivers until its marker: ace-media sends it after the producer's last unit (its end
   * frame, or its connection dropping), or after the close for a source it reads itself, whose
   * pictures come on the same lane as the close.
   */
  #retire(path: Path): void {
    path.token?.fill(0);
    path.token = undefined;
    if (!path.pointed || path.marked) {
      this.#finish(path, path.marked?.interrupted ?? false, true);
      return;
    }
    // ace-media stays up until the path's last unit is in, whatever the settings say now.
    path.release = this.#options.port.need();
    path.draining = this.#options.schedule(() => this.#finish(path, true, true), drainMs);
    if (readByMedia.has(path.entry.producer.kind)) this.#closeInMedia(path);
  }

  #marked(path: Path, interrupted: boolean): void {
    if (path.marked) return;
    path.marked = { interrupted };
    // A live path's producer ended on its own: its status follows and reopens the source.
    if (path.draining) this.#finish(path, interrupted, true);
  }

  #closeInMedia(path: Path): void {
    if (path.closeSent) return;
    path.closeSent = true;
    this.#send({ type: "source.close", source: path.id });
  }

  /** The path is done: its handle closes, and the producer hears how it ended. */
  #finish(path: Path, interrupted: boolean, close: boolean): void {
    if (!this.#paths.has(path.id)) return;
    this.#paths.delete(path.id);
    if (path.entry.acceleratedBy === path.id) {
      path.entry.acceleratedBy = undefined;
      this.#options.acceleration?.(path.entry.producer, undefined);
    }
    path.draining?.();
    path.draining = undefined;
    this.#options.router.close(path.handle);
    if (close) this.#closeInMedia(path);
    path.release?.();
    path.release = undefined;
    if (path.pointed && !path.reported) {
      path.reported = true;
      path.entry.producer.pathEnded?.(path.id, interrupted);
    }
  }

  #close(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.generation++;
    this.#entries.delete(entry);
    const live = entry.live;
    this.#live(entry, undefined);
    entry.state = "off";
    // The capture is gone: nothing is left to deliver to.
    if (live) this.#finish(live, true, true);
    entry.release?.();
    entry.release = undefined;
  }
}
