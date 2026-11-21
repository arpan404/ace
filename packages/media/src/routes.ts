import type { MediaHealth } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

/**
 * Routes and setting combinations (docs/media/plan.md). Every producer streams into ace-media's
 * ingest (X2 removed the daemon's own path and its tee for live video). For each source kind:
 * whether its producer streams now, whether ace-media sends its frames back on egress, and
 * whether ace-media delivers its viewers.
 *
 * Viewers are only ever ace-media's (X3): the daemon has no deliverer of its own. While
 * ace-media isn't healthy, or can't take a kind, that kind's producer streams nowhere, it has
 * no deliverer (`none`), and its live views say why (`undeliveredReason`).
 *
 * Recordings and stills have no legacy consumer since X1: a recording takes the source's frames
 * from egress and tees them into ace-media's recorder (`tee-recordings.ts`), so ace-media always
 * hands a source it ingests back on egress. A still is ace-media's for a source it has, else the
 * source's own capture.
 */

export type SourceKind = Extract<ToMedia, { type: "source.open" }>["origin"]["kind"];
export const sourceKinds: readonly SourceKind[] = [
  "tab",
  "tab-pictures",
  "user-tab",
  "embedded",
  "screen",
  "screen-pictures",
  "simulator",
  "scrcpy",
  "emulator-frames",
];

/** Who delivers a source's pictures to viewers: ace-media, or nobody while it can't. */
export type DelivererPlace = "ace-media" | "none";

export type SourceRoute = {
  /** `none`: ace-media can't take the source now, so nothing streams and its views retry. */
  producer: "ace-media" | "none";
  /** ace-media sends the source's frames back to the daemon. */
  egress: boolean;
  deliverer: DelivererPlace;
};

export type MediaRoutes = Record<SourceKind, SourceRoute>;

/**
 * What this build can route through ace-media. Each piece is landed by its own PR, which turns
 * its flag on; until then that `auto` setting behaves as `legacy`.
 */
export type RouteCapabilities = {
  /** Source kinds whose producers can stream into ace-media's ingest (E1–E4). */
  ingest: readonly SourceKind[];
  /** ace-media serves viewers (D1). */
  delivery: boolean;
};

/**
 * Today's build: browser producers stream into ace-media (E4), and ace-media serves viewers on
 * clients' media connections (D1).
 */
export const builtRouteCapabilities: RouteCapabilities = {
  ingest: ["tab", "tab-pictures", "user-tab", "embedded"],
  delivery: true,
};

/**
 * This build's capabilities on `platform`. On a Mac the screen helper streams into ace-media's
 * ingest too (E3): screens, and Android emulators whose picture it encodes (`--encode-frames`);
 * and ace-media reads a Simulator's serve-sim stream itself. The daemon forwards an Android
 * device's scrcpy units everywhere. On Windows the screen helper encodes with Media Foundation
 * and streams into ace-media's ingest pipe (E1); Linux screens stream in from their helper (E2).
 */
export function platformRouteCapabilities(platform: string): RouteCapabilities {
  // The daemon forwards an Android device's scrcpy units itself, on every platform, and a
  // JPEG-only screen helper's pictures go to ace-media's encoder wherever ace-media runs.
  const ingest = [...builtRouteCapabilities.ingest, "scrcpy", "screen-pictures"] as const;
  return {
    ...builtRouteCapabilities,
    ingest:
      platform === "darwin"
        ? [...ingest, "screen", "emulator-frames", "simulator"]
        : platform === "win32" || platform === "linux"
          ? [...ingest, "screen"]
          : [...ingest],
  };
}

/**
 * The route for one source kind. Anything but a healthy ace-media stops its producer, and with
 * it its delivery.
 */
export function sourceRoute(
  kind: SourceKind,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): SourceRoute {
  const healthy = health === "healthy";
  // ace-media is the only media path: every producer that can stream into it does, while it is
  // healthy.
  const producer = healthy && capabilities.ingest.includes(kind) ? "ace-media" : "none";
  // ace-media delivers what its producer streams into it.
  const deliverer = producer === "ace-media" && capabilities.delivery ? "ace-media" : "none";
  return {
    producer,
    // The daemon's recording feed takes every ingested source's frames from egress (X1).
    egress: producer === "ace-media",
    deliverer,
  };
}

/**
 * Why a source's live views get no pictures now, for the person (X3's "Unavailable"), or
 * undefined while ace-media delivers it. Pure: the route's inputs.
 */
export function undeliveredReason(
  kind: SourceKind,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): string | undefined {
  if (sourceRoute(kind, health, capabilities).deliverer === "ace-media") return undefined;
  if (health === "restarting") return "Live video is starting. It shows in a moment.";
  if (health === "unavailable")
    return "Live video stopped: ace's media process keeps failing on this computer. Restart ace to try again.";
  return "This computer can't stream this live view yet.";
}

export function mediaRoutes(health: MediaHealth, capabilities: RouteCapabilities): MediaRoutes {
  const routes = {} as MediaRoutes;
  for (const kind of sourceKinds) routes[kind] = sourceRoute(kind, health, capabilities);
  return routes;
}

/** The source kinds whose route differs between two route tables. */
export function changedRoutes(before: MediaRoutes, after: MediaRoutes): SourceKind[] {
  return sourceKinds.filter((kind) => {
    const a = before[kind],
      b = after[kind];
    return a.producer !== b.producer || a.egress !== b.egress || a.deliverer !== b.deliverer;
  });
}
