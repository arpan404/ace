import { MediaAccelerationStore } from "./acceleration.ts";
import { EgressRouter } from "./egress.ts";
import { pictureCodecs, pictureEncoders } from "./picture-codecs.ts";
import { RouteWatch } from "./route-watch.ts";
import { builtRouteCapabilities, sourceKinds, type RouteCapabilities } from "./routes.ts";
import { IngestSources } from "./ingest-sources.ts";
import {
  MediaSupervisor,
  secureRandomBytes,
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
        options.onMessage?.(message, payload);
      },
      onEgress: (frame) => this.egress.push(frame),
      onExit: (exit) => {
        // Producers go back to the daemon first, with nothing left to drain.
        this.sources.exited();
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
      acceleration: (subject, acceleration) => this.acceleration.report(subject, acceleration),
    });
  }

  /** The codecs ace-media encodes JPEG sources in here, best first (`picture-codecs.ts`). */
  pictureCodecs(): string[] {
    return pictureCodecs(this.supervisor.capabilities() ?? [], this.#encoders);
  }

  /** A media setting changed: routes move, and sources follow. */
  settingsChanged(): void {
    this.routes.update();
    this.sources.routesChanged(sourceKinds);
  }

  dispose(): void {
    this.supervisor.dispose();
  }
}
