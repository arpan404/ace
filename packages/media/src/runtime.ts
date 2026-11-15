import { MediaAccelerationStore } from "./acceleration.ts";
import { EgressRouter } from "./egress.ts";
import { pictureCodecs, pictureEncoders } from "./picture-codecs.ts";
import { RouteWatch } from "./route-watch.ts";
import { builtRouteCapabilities, sourceKinds, type RouteCapabilities } from "./routes.ts";
import { IngestSources } from "./ingest-sources.ts";
import { MediaConnections, MediaIssue } from "./media-connections.ts";
import { MediaViewers, type MediaDeliveryPort } from "./media-viewers.ts";
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
  /** The platform ace-media runs on (`process.platform`): which encoders it builds for pictures.
   * Absent, no hardware encoder is offered. */
  platform?: string;
  /** The store to keep what ace-media runs on in; one of its own unless given. */
  acceleration?: MediaAccelerationStore;
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
  /** What ace-media runs on: its probe's list and each source's steps. */
  readonly acceleration: MediaAccelerationStore;

  readonly #encoders: readonly string[];

  constructor(options: MediaRuntimeOptions) {
    this.#encoders = options.platform === undefined ? [] : pictureEncoders(options.platform);
    this.acceleration = options.acceleration ?? new MediaAccelerationStore();
    const capabilities = options.capabilities ?? builtRouteCapabilities;
    this.supervisor = new MediaSupervisor({
      ...options,
      replay: () => {
        this.routes.update();
        this.sources.replay();
      },
      onMessage: (message, payload) => {
        this.acceleration.message(message);
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
        this.acceleration.exited();
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
        ingest: () => {
          const ingest = this.supervisor.ingest();
          const pid = this.supervisor.snapshot().pid;
          return ingest && { ...ingest, ...(pid ? { pid } : {}) };
        },
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
      acceleration: (subject, acceleration) => this.acceleration.report(subject, acceleration),
    });
    const randomBytes = options.randomBytes ?? secureRandomBytes;
    this.connections = new MediaConnections({
      port: {
        send: (message, payload) => this.supervisor.send(message, payload),
        revoke: (message) => this.supervisor.revoke(message),
        directPort: () => this.supervisor.listening()?.loopbackPort,
        need: () => this.supervisor.need(),
        sleep: (ms) => new Promise((resolve) => options.clock.setTimeout(resolve, ms)),
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
      now: () => options.clock.now(),
    });
    this.#stopLinks = pumpSessionLinks(this.links, options.clock, (message) =>
      this.supervisor.send(message),
    );
  }

  /** The codecs ace-media encodes JPEG sources in here, best first (`picture-codecs.ts`). */
  pictureCodecs(): string[] {
    return pictureCodecs(this.supervisor.capabilities() ?? [], this.#encoders);
  }

  /** What the bridges bind subscribes through (D1). */
  delivery(): MediaDeliveryPort {
    return {
      // Frames must be in ace-media for it to deliver them: the producer streams there.
      serves: (kind) => {
        const route = this.routes.routes()[kind];
        return route.deliverer === "ace-media" && route.producer === "ace-media";
      },
      bind: (intent) => this.viewers.bind(intent),
      granted: (viewer) => this.viewers.granted(viewer),
      poster: (viewer) => this.viewers.poster(viewer),
      configure: (viewer, viewport, audio) => this.viewers.configure(viewer, viewport, audio),
      pause: (viewer, paused) => this.viewers.pause(viewer, paused),
      regrant: (viewer) => this.viewers.regrant(viewer),
      unbind: (viewer) => this.viewers.unbind(viewer),
    };
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
