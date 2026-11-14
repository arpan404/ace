import { EgressRouter } from "./egress.ts";
import { IngestSources } from "./ingest-sources.ts";
import { RouteWatch } from "./route-watch.ts";
import { builtRouteCapabilities, type MediaRoutes, type RouteCapabilities } from "./routes.ts";
import { MediaSupervisor, type MediaSupervisorOptions } from "./supervisor.ts";

/**
 * The daemon's phase 2 wiring (docs/media/plan.md, "Routes and setting combinations"): one
 * supervised ace-media, the route table, the egress router and the producers streaming into
 * ingest. Producer packages get `sources` and register their sources there; nothing else is
 * theirs to drive. With every setting `legacy` (the default) nothing starts ace-media.
 */
export type MediaProducersOptions = Omit<
  MediaSupervisorOptions,
  "replay" | "onMessage" | "onEgress" | "onExit"
> & {
  /** The running platform, for this build's capabilities. */
  platform: string;
  /** Overrides this build's capabilities on `platform`. */
  capabilities?: () => RouteCapabilities;
  randomBytes: (length: number) => Uint8Array;
  /** Route changes, after producers were told (for diagnostics and tests). */
  onRoutes?: (routes: MediaRoutes) => void;
};

export class MediaProducers {
  readonly supervisor: MediaSupervisor;
  readonly routes: RouteWatch;
  readonly router: EgressRouter;
  readonly sources: IngestSources;

  constructor(options: MediaProducersOptions) {
    const capabilities = options.capabilities ?? (() => builtRouteCapabilities(options.platform));
    const supervisor: MediaSupervisor = new MediaSupervisor({
      ...options,
      replay: () => {
        routes.update();
        sources.replay();
      },
      onMessage: (message) => sources.message(message),
      onEgress: (frame) => router.push(frame),
      onExit: () => {
        sources.exited();
        routes.update();
      },
    });
    const routes: RouteWatch = new RouteWatch({
      settings: options.settings,
      health: () => supervisor.health(),
      capabilities,
      onChange: (table, changed) => {
        sources.routesChanged(changed);
        options.onRoutes?.(table);
      },
    });
    const router = new EgressRouter((kind) => routes.routes()[kind]);
    const sources: IngestSources = new IngestSources({
      port: {
        send: (message, payload) => supervisor.send(message, payload),
        ingest: () => supervisor.ingest(),
        need: () => supervisor.need(),
      },
      router,
      routes: () => routes.routes(),
      settings: options.settings,
      capabilities,
      randomBytes: options.randomBytes,
      log: (message, fields) => options.log("warn", message, fields),
    });
    this.supervisor = supervisor;
    this.routes = routes;
    this.router = router;
    this.sources = sources;
  }

  /** A media setting changed. */
  settingsChanged(): void {
    this.routes.update();
  }

  dispose(): void {
    this.supervisor.dispose();
  }
}
