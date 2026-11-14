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
 * daemon's side, one for every kind (browser tabs, screens, devices). While a kind's route says
 * `producer: "ace-media"`, each producer's source is opened in ace-media with a fresh id,
 * single-use token and egress handle, and once ace-media reports it `starting` the producer is
 * pointed at the ingest. When the route moves back (a setting, or ace-media restarting or
 * unavailable) the producer is pointed back at the daemon, and its handle keeps delivering until
 * ace-media's end marker for it arrives on egress, after its last unit. The handle closes only
 * then; a marker that never comes within `drainMs` is reported as a cut path, never as a clean
 * one. The daemon's state is the truth: every ace-media start opens each source again.
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
   * Points the producer at ace-media (an address) or back at the daemon (undefined). Resolves
   * once the producer has switched; a rejection keeps this source on the daemon until its route
   * changes again.
   */
  point: (address: IngestAddress | undefined) => Promise<void>;
  /** ace-media's egress dropped deltas or a consumer needs one: a keyframe of this encode. */
  keyframe: (encode: number) => void;
  /**
   * The ace-media path `path` ended: every unit it carried has arrived (`interrupted` false),
   * or it was cut and units may be missing. Always after the `point` that left it.
   */
  pathEnded?: (path: string, interrupted: boolean) => void;
  /** ace-media ended the source with a reason: it stays on the daemon until its route changes. */
  refused?: (reason: string | undefined) => void;
};

/** What the sources need of the supervisor. */
export type IngestPort = {
  send: (message: ToMedia, payload?: Uint8Array) => boolean;
  ingest: () => { socket: string; websocketPort: number } | undefined;
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
};

/** Reconnects after the producer's connection ended, before the source stays on the daemon. */
export const maxIngestReopens = 3;
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
  state: "daemon" | "opening" | "ingest";
  /** The open in the running ace-media, while there is one. */
  live: Path | undefined;
  /** Keeps ace-media running while settings want this source there, through restarts. */
  release: (() => void) | undefined;
  encodes: EncodeSpec[] | undefined;
  /** Bumped by every switch, so a late answer to an older one is ignored. */
  generation: number;
  /** Ingest failed or was refused: it stays on the daemon until its route changes. */
  failed: boolean;
  reopens: number;
  closed: boolean;
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
};

export type IngestSource = {
  /** The producer streams to ace-media now. */
  streaming(): boolean;
  /** The producer's ingest connection ended (it said so): open the source again. */
  reconnect(): void;
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
      state: "daemon",
      live: undefined,
      release: undefined,
      encodes: undefined,
      generation: 0,
      failed: false,
      reopens: 0,
      closed: false,
    };
    this.#entries.add(entry);
    this.#sync(entry);
    return {
      streaming: () => entry.state === "ingest",
      reconnect: () => this.#reconnect(entry),
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
        this.#sync(entry);
      }
  }

  /** The supervisor's `replay`: ace-media is up, with a new ingest. */
  replay(): void {
    for (const entry of this.#entries) this.#sync(entry);
  }

  /** The supervisor's `onExit`: every id, token and handle of that process is gone. */
  exited(): void {
    for (const entry of this.#entries) {
      const live = entry.live;
      entry.live = undefined;
      entry.generation++;
      const was = entry.state;
      entry.state = "daemon";
      if (was === "ingest") void entry.producer.point(undefined).catch(() => {});
      if (live) this.#finish(live, true, false);
    }
    // Deleting while iterating a Map is safe: finished paths aren't visited again.
    for (const path of this.#paths.values()) this.#finish(path, true, false);
  }

  /** The supervisor's `onMessage`. */
  message(message: FromMedia): void {
    if (message.type !== "source.status" && message.type !== "source.keyframe") return;
    const path = this.#paths.get(message.source);
    if (!path || path.draining) return;
    const { entry } = path;
    if (entry.closed || entry.live !== path) return;
    if (message.type === "source.keyframe") {
      if (entry.state === "ingest") entry.producer.keyframe(message.encode);
      return;
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
    if (desired && entry.state === "daemon") this.#open(entry, route);
    else if (!desired && entry.state !== "daemon") this.#leave(entry);
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
    };
    this.#paths.set(id, path);
    entry.live = path;
    entry.state = "opening";
    if (route.egress) this.#send({ type: "source.egress", source: id, on: true });
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
    };
    entry.producer.point(address).then(
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
      },
    );
  }

  /** Points the producer back at the daemon; its path drains until its marker. */
  #leave(entry: Entry): void {
    const live = entry.live;
    entry.live = undefined;
    entry.generation++;
    const was = entry.state;
    entry.state = "daemon";
    if (was === "ingest") void entry.producer.point(undefined).catch(() => {});
    if (live) this.#retire(live);
    if (!this.wanted(entry.producer.kind)) {
      entry.release?.();
      entry.release = undefined;
    }
  }

  #reconnect(entry: Entry): void {
    if (entry.closed || entry.state === "daemon") return;
    const live = entry.live;
    entry.live = undefined;
    entry.state = "daemon";
    entry.generation++;
    if (live) this.#retire(live);
    if (++entry.reopens > maxIngestReopens) {
      entry.failed = true;
      void entry.producer.point(undefined).catch(() => {});
      return;
    }
    // Reopened at once, without a detour to the daemon: the producer gets its new address.
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
    entry.live = undefined;
    entry.state = "daemon";
    // The capture is gone: nothing is left to deliver to.
    if (live) this.#finish(live, true, true);
    entry.release?.();
    entry.release = undefined;
  }
}
