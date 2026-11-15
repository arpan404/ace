import { EgressRouter } from "./egress.ts";
import { RouteWatch } from "./route-watch.ts";
import { builtRouteCapabilities, sourceKinds, type RouteCapabilities } from "./routes.ts";
import { IngestSources } from "./ingest-sources.ts";
import { MediaConnections, MediaIssue } from "./media-connections.ts";
import { MediaViewers } from "./media-viewers.ts";
import { SessionLinks, pumpSessionLinks } from "./session-link.ts";
import {
  MediaSupervisor,
  secureRandomBytes,
  systemWallClock,
  type MediaExit,
  type MediaSupervisorOptions,
} from "./supervisor.ts";
import type { FromMedia } from "./wire.ts";

/**
 * The daemon's ace-media, put together: the supervisor, the live route table, the egress
 * router and the sources whose producers stream into it. One per daemon. Settings are read
 * live; call `settingsChanged()` when one changes.
 */

export type MediaRuntimeOptions = Omit<
  MediaSupervisorOptions,
  "replay" | "onMessage" | "onEgress" | "onExit"
> & {
  id: () => string;
  /** What this build routes through ace-media; `builtRouteCapabilities` unless a test says. */
  capabilities?: RouteCapabilities;
  /** The daemon's wall clock in Unix ms, which media tickets expire on. */
  wallClock?: () => number;
  onMessage?: (message: FromMedia, payload: Uint8Array) => void;
  onExit?: (exit: MediaExit) => void;
};

export class MediaRuntime {
  readonly supervisor: MediaSupervisor;
  readonly routes: RouteWatch;
  readonly egress: EgressRouter;
  readonly sources: IngestSources;
  /** Clients' media connections and the views ace-media delivers on them (D1). */
  readonly connections: MediaConnections;
  readonly viewers: MediaViewers;
  /** Each main session's link, told to ace-media while the session has a media connection. */
  readonly links = new SessionLinks();
  readonly #stopLinks: () => void;

  constructor(options: MediaRuntimeOptions) {
    const capabilities = options.capabilities ?? builtRouteCapabilities;
    this.supervisor = new MediaSupervisor({
      ...options,
      replay: () => {
        this.routes.update();
        this.sources.replay();
      },
      onMessage: (message, payload) => {
        this.sources.message(message);
        this.connections.received(message);
        this.viewers.received(message, payload);
        this.links.received(message);
        options.onMessage?.(message, payload);
      },
      onEgress: (frame) => this.egress.push(frame),
      onExit: (exit) => {
        // Producers go back to the daemon first, with nothing left to drain.
        this.sources.exited();
        this.connections.exited();
        this.viewers.exited();
        this.links.restarted();
        this.routes.update();
        options.onExit?.(exit);
      },
    });
    this.routes = new RouteWatch({
      settings: options.settings,
      health: () => this.supervisor.health(),
      capabilities: () => capabilities,
      onChange: (_routes, changed) => this.sources.routesChanged(changed),
    });
    this.egress = new EgressRouter((kind) => this.routes.routes()[kind]);
    this.sources = new IngestSources({
      port: {
        send: (message, payload) => this.supervisor.send(message, payload),
        ingest: () => this.supervisor.ingest(),
        need: () => this.supervisor.need(),
      },
      router: this.egress,
      routes: () => this.routes.routes(),
      settings: options.settings,
      capabilities: () => capabilities,
      randomBytes: options.randomBytes ?? secureRandomBytes,
      id: options.id,
      schedule: (callback, ms) => options.clock.setTimeout(callback, ms),
      onLive: (producer, path) => this.viewers.live(producer, path),
    });
    const randomBytes = options.randomBytes ?? secureRandomBytes;
    this.connections = new MediaConnections({
      port: {
        send: (message, payload) => this.supervisor.send(message, payload),
        revoke: (message) => this.supervisor.revoke(message),
        directPort: () => this.supervisor.listening()?.loopbackPort,
      },
      issue: new MediaIssue(),
      now: options.wallClock ?? systemWallClock,
      randomBytes,
      id: options.id,
    });
    this.viewers = new MediaViewers({
      connections: this.connections,
      live: () => this.sources.live(),
      send: (message) => this.supervisor.send(message),
      id: options.id,
      schedule: (callback, ms) => options.clock.setTimeout(callback, ms),
    });
    this.#stopLinks = pumpSessionLinks(this.links, options.clock, (message) =>
      this.supervisor.send(message),
    );
  }

  /**
   * The codecs ace-media encodes JPEG sources in here, best first: each family a working
   * hardware encoder covers, and H.264 from the last-resort encoder; H.264 first, since every
   * viewer decodes it. Empty before the probe's result.
   */
  pictureCodecs(): string[] {
    const codecs: string[] = [];
    for (const entry of this.supervisor.capabilities() ?? []) {
      if (entry.step !== "encode" || entry.state !== "ok" || !entry.codec) continue;
      const family = entry.codec.slice(0, 4);
      const usable = entry.backend === "chrome" ? family === "avc1" : entry.hardware;
      if (!usable || (family !== "avc1" && family !== "hvc1")) continue;
      if (!codecs.some((codec) => codec.startsWith(family))) codecs.push(entry.codec);
    }
    return codecs.toSorted((a, b) => Number(b.startsWith("avc1")) - Number(a.startsWith("avc1")));
  }

  /** A media setting changed: routes move, and sources follow. */
  settingsChanged(): void {
    this.routes.update();
    this.sources.routesChanged(sourceKinds);
  }

  dispose(): void {
    this.#stopLinks();
    this.supervisor.dispose();
  }
}
