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
 * Producers that stream straight into ace-media's ingest (docs/media/plan.md, phase 2, E1–E4):
 * the daemon's side. While a source kind's route says `producer: "ace-media"`, each producer's
 * source is opened in ace-media with a fresh single-use token, and once ace-media reports it
 * `starting` the producer is pointed at the ingest socket. When the route moves back (a setting,
 * or ace-media restarting or unavailable) the producer is pointed back at the daemon, and its
 * source keeps its egress until the producer has switched, so units already sent to ace-media
 * still reach the daemon's consumers. The daemon's state is the truth: every ace-media start
 * opens each source again.
 */

export type Origin = Extract<ToMedia, { type: "source.open" }>["origin"];

/** Where a producer sends: ace-media's ingest socket with its source's token. */
export type IngestAddress = { socket: string; token: Uint8Array; epoch: number };

export type IngestProducer = {
  source: string;
  kind: SourceKind;
  origin: Origin;
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
  /** ace-media's egress dropped deltas or a consumer needs one: a keyframe, now. */
  keyframe: () => void;
};

/** What the sources need of the supervisor. */
export type IngestPort = {
  send: (message: ToMedia, payload?: Uint8Array) => boolean;
  ingest: () => { socket: string } | undefined;
  need: () => () => void;
};

export type IngestSourcesOptions = {
  port: IngestPort;
  router: EgressRouter;
  /** The daemon's current table (`RouteWatch.routes()`). */
  routes: () => MediaRoutes;
  /** The settings and capabilities the table comes from, to know which sources want ace-media
   * running while it restarts. */
  settings: () => MediaSettings;
  capabilities: () => RouteCapabilities;
  randomBytes: (length: number) => Uint8Array;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/** Reconnects after the producer's connection ended, before the source stays on the daemon. */
export const maxIngestReopens = 3;

type Entry = {
  producer: IngestProducer;
  state: "daemon" | "opening" | "ingest" | "draining";
  handle: number | undefined;
  /** The token of a `source.open` ace-media hasn't confirmed yet. */
  token: Uint8Array | undefined;
  /** The route this source was opened or last configured with. */
  route: SourceRoute | undefined;
  /** Keeps ace-media running while settings want this source there, through restarts. */
  release: (() => void) | undefined;
  /** Bumped by every switch, so a late answer to an older one is ignored. */
  generation: number;
  /** Ingest failed for this source: it stays on the daemon until its route changes. */
  failed: boolean;
  reopens: number;
  closed: boolean;
};

export type IngestSource = {
  /** The producer's ingest connection ended (it said so): open the source again. */
  reconnect(): void;
  close(): void;
};

export class IngestSources {
  readonly #options: IngestSourcesOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: IngestSourcesOptions) {
    this.#options = options;
  }

  add(producer: IngestProducer): IngestSource {
    if (this.#entries.has(producer.source)) throw new Error("Ingest source already added");
    const entry: Entry = {
      producer,
      state: "daemon",
      handle: undefined,
      token: undefined,
      route: undefined,
      release: undefined,
      generation: 0,
      failed: false,
      reopens: 0,
      closed: false,
    };
    this.#entries.set(producer.source, entry);
    this.#sync(entry);
    return {
      reconnect: () => this.#reconnect(entry),
      close: () => this.#close(entry),
    };
  }

  /** `RouteWatch.onChange`: move the producers of these kinds. */
  routesChanged(kinds: readonly SourceKind[]): void {
    for (const entry of this.#entries.values())
      if (kinds.includes(entry.producer.kind)) {
        entry.failed = false;
        entry.reopens = 0;
        this.#sync(entry);
      }
  }

  /** The supervisor's `replay`: ace-media is up, with a new ingest socket. */
  replay(): void {
    for (const entry of this.#entries.values()) this.#sync(entry);
  }

  /** The supervisor's `onExit`: every handle and token of that process is gone. */
  exited(): void {
    for (const entry of this.#entries.values()) {
      if (entry.state === "daemon") continue;
      this.#forget(entry);
      entry.state = "daemon";
      entry.generation++;
      void entry.producer.point(undefined).catch(() => {});
    }
  }

  /** The supervisor's `onMessage`. */
  message(message: FromMedia): void {
    if (message.type !== "source.status" && message.type !== "source.keyframe") return;
    const entry = this.#entries.get(message.source);
    if (!entry || entry.closed) return;
    if (message.type === "source.keyframe") {
      if (entry.state === "ingest") entry.producer.keyframe();
      return;
    }
    if (message.status === "starting") this.#started(entry);
    else if (message.status === "playing") entry.reopens = 0;
    else if (entry.state === "ingest") this.#reconnect(entry);
  }

  #wanted(kind: SourceKind): boolean {
    const { settings, capabilities } = this.#options;
    return sourceRoute(kind, settings(), "healthy", capabilities()).producer === "ace-media";
  }

  #sync(entry: Entry): void {
    if (entry.closed) return;
    const { kind } = entry.producer;
    if (this.#wanted(kind)) entry.release ??= this.#options.port.need();
    else {
      entry.release?.();
      entry.release = undefined;
    }
    const route = this.#options.routes()[kind];
    const desired = route.producer === "ace-media" && !entry.failed;
    if (desired && entry.state === "daemon") this.#open(entry, route);
    else if (!desired && (entry.state === "opening" || entry.state === "ingest"))
      this.#leave(entry);
    else if (
      desired &&
      (entry.state === "opening" || entry.state === "ingest") &&
      entry.route?.egress !== route.egress
    ) {
      entry.route = route;
      this.#options.port.send({
        type: "source.egress",
        source: entry.producer.source,
        on: route.egress,
      });
    }
  }

  #open(entry: Entry, route: SourceRoute): void {
    const { port, router, randomBytes } = this.#options;
    if (!port.ingest()) return;
    const { producer } = entry;
    const handle = router.open(producer.source, producer.kind, producer.consumers, () =>
      entry.state === "draining" && entry.route
        ? entry.route
        : this.#options.routes()[producer.kind],
    );
    const token = randomBytes(32);
    const opened = port.send(
      {
        type: "source.open",
        source: producer.source,
        handle,
        epoch: producer.epoch(),
        origin: producer.origin,
        ...(producer.sessionId ? { sessionId: producer.sessionId } : {}),
        ...(producer.deviceId ? { deviceId: producer.deviceId } : {}),
      },
      token.slice(),
    );
    if (!opened) {
      router.close(handle);
      token.fill(0);
      return;
    }
    entry.handle = handle;
    entry.token = token;
    entry.route = route;
    entry.state = "opening";
    if (route.egress) port.send({ type: "source.egress", source: producer.source, on: true });
  }

  /** ace-media has the source: hand the producer its address. */
  #started(entry: Entry): void {
    const token = entry.token;
    const socket = this.#options.port.ingest()?.socket;
    if (entry.state !== "opening" || !token || !socket) return;
    entry.token = undefined;
    entry.state = "ingest";
    const generation = ++entry.generation;
    const address = { socket, token, epoch: entry.producer.epoch() };
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

  /** Points the producer back at the daemon; the source keeps its egress until it has. */
  #leave(entry: Entry): void {
    entry.token?.fill(0);
    entry.token = undefined;
    entry.state = "draining";
    const generation = ++entry.generation;
    const done = () => {
      if (entry.generation !== generation) return;
      this.#forget(entry);
      entry.state = "daemon";
      this.#sync(entry);
    };
    entry.producer.point(undefined).then(done, done);
  }

  #reconnect(entry: Entry): void {
    if (entry.closed || entry.state === "daemon" || entry.state === "draining") return;
    this.#forget(entry);
    entry.state = "daemon";
    entry.generation++;
    if (++entry.reopens > maxIngestReopens) {
      entry.failed = true;
      void entry.producer.point(undefined).catch(() => {});
      return;
    }
    this.#sync(entry);
  }

  /** Closes the source in ace-media and its handle here. */
  #forget(entry: Entry): void {
    entry.token?.fill(0);
    entry.token = undefined;
    if (entry.handle === undefined) return;
    this.#options.router.close(entry.handle);
    entry.handle = undefined;
    entry.route = undefined;
    this.#options.port.send({ type: "source.close", source: entry.producer.source });
  }

  #close(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.generation++;
    this.#forget(entry);
    entry.release?.();
    entry.release = undefined;
    this.#entries.delete(entry.producer.source);
  }
}
