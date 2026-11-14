import { EgressRouter } from "./egress.ts";
import { RouteWatch } from "./route-watch.ts";
import { builtRouteCapabilities, type RouteCapabilities, type SourceKind } from "./routes.ts";
import { MediaSources } from "./sources.ts";
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
};

export class MediaRuntime {
  readonly supervisor: MediaSupervisor;
  readonly routes: RouteWatch;
  readonly egress: EgressRouter;
  readonly sources: MediaSources;

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
        options.onMessage?.(message, payload);
      },
      onEgress: (frame) => this.egress.push(frame),
      onExit: (exit) => {
        // Producers go back to the daemon first, with nothing left to drain.
        this.sources.exited();
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
    this.egress = new EgressRouter((kind) => this.sources.egressRoute(kind));
    const wanted = (kind: SourceKind) =>
      options.settings().encode === "auto" && capabilities.ingest.includes(kind);
    this.sources = new MediaSources({
      send: (message, payload) => this.supervisor.send(message, payload),
      ingest: () => this.supervisor.ingest(),
      need: () => this.supervisor.need(),
      route: (kind) => this.routes.routes()[kind],
      wanted,
      egress: this.egress,
      randomBytes: options.randomBytes ?? secureRandomBytes,
      id: options.id,
      setTimeout: (callback, ms) => options.clock.setTimeout(callback, ms),
    });
  }

  /** A media setting changed: routes move, and sources follow. */
  settingsChanged(): void {
    this.routes.update();
    this.sources.routesChanged(["tab", "tab-pictures", "user-tab", "embedded"]);
  }

  dispose(): void {
    this.supervisor.dispose();
  }
}
