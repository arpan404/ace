import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

/**
 * Routes and setting combinations (docs/media/plan.md). For each source kind: where its producer
 * sends frames, whether the daemon tees them into ace-media or ace-media sends them back on
 * egress, and whether each consumer (deliverer, recorder, still maker) is the daemon's legacy
 * one or ace-media's. Every combination of settings, health and capabilities is a complete route:
 * each consumer gets frames from somewhere.
 */

export type SourceKind = Extract<ToMedia, { type: "source.open" }>["origin"]["kind"];
export const sourceKinds: readonly SourceKind[] = [
  "tab",
  "tab-pictures",
  "user-tab",
  "embedded",
  "screen",
  "simulator",
  "scrcpy",
  "emulator-frames",
];

/** Where a consumer runs: in the daemon (legacy) or in ace-media. */
export type ConsumerPlace = "legacy" | "ace-media";

export type SourceRoute = {
  producer: "daemon" | "ace-media";
  /** The daemon copies the frames it receives into ace-media's ingest. */
  tee: boolean;
  /** ace-media sends the source's frames back to the daemon. */
  egress: boolean;
  deliverer: ConsumerPlace;
  recorder: ConsumerPlace;
  stills: ConsumerPlace;
};

export type MediaRoutes = Record<SourceKind, SourceRoute>;

/**
 * What this build can route through ace-media. Each piece is landed by its own PR, which turns
 * its flag on; until then that `auto` setting behaves as `legacy`.
 */
export type RouteCapabilities = {
  /** Source kinds whose producers can stream into ace-media's ingest (E1–E4). */
  ingest: readonly SourceKind[];
  /** ace-media records (F1). */
  recordings: boolean;
  /** ace-media makes stills (F2). */
  stills: boolean;
  /** ace-media serves viewers (D1). */
  delivery: boolean;
};

/** Today's build: no route through ace-media is complete yet, so every setting acts as legacy. */
export const builtRouteCapabilities: RouteCapabilities = {
  ingest: [],
  recordings: false,
  stills: false,
  delivery: false,
};

function place(setting: "auto" | "legacy", capable: boolean, healthy: boolean): ConsumerPlace {
  return setting === "auto" && capable && healthy ? "ace-media" : "legacy";
}

/** The route for one source kind. Anything but a healthy ace-media makes every `auto` legacy. */
export function sourceRoute(
  kind: SourceKind,
  settings: MediaSettings,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): SourceRoute {
  const healthy = health === "healthy";
  const deliverer = place(settings.delivery, capabilities.delivery, healthy);
  const recorder = place(settings.recordings, capabilities.recordings, healthy);
  const stills = place(settings.stills, capabilities.stills, healthy);
  const producer =
    settings.encode === "auto" && healthy && capabilities.ingest.includes(kind)
      ? "ace-media"
      : "daemon";
  const anyInMedia =
    deliverer === "ace-media" || recorder === "ace-media" || stills === "ace-media";
  const anyLegacy = deliverer === "legacy" || recorder === "legacy" || stills === "legacy";
  return {
    producer,
    tee: producer === "daemon" && anyInMedia,
    egress: producer === "ace-media" && anyLegacy,
    deliverer,
    recorder,
    stills,
  };
}

export function mediaRoutes(
  settings: MediaSettings,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): MediaRoutes {
  const routes = {} as MediaRoutes;
  for (const kind of sourceKinds) routes[kind] = sourceRoute(kind, settings, health, capabilities);
  return routes;
}

/** The source kinds whose route differs between two route tables. */
export function changedRoutes(before: MediaRoutes, after: MediaRoutes): SourceKind[] {
  return sourceKinds.filter((kind) => {
    const a = before[kind],
      b = after[kind];
    return (
      a.producer !== b.producer ||
      a.tee !== b.tee ||
      a.egress !== b.egress ||
      a.deliverer !== b.deliverer ||
      a.recorder !== b.recorder ||
      a.stills !== b.stills
    );
  });
}
