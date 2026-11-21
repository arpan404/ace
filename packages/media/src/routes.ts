import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { ToMedia } from "./wire.ts";

/**
 * Routes and setting combinations (docs/media/plan.md). For each source kind: where its producer
 * sends frames, whether the daemon tees them into ace-media or ace-media sends them back on
 * egress, and whether ace-media delivers its viewers. Every combination of settings, health and
 * capabilities is a complete route.
 *
 * Viewers are only ever ace-media's (X3): the daemon has no deliverer of its own. A source
 * whose frames aren't in ace-media has no deliverer (`none`), and its live views say why
 * (`undeliveredReason`).
 *
 * Recordings and stills have no legacy consumer since X1. Until X2 moves every producer into
 * ace-media, a recording takes the source's frames where the daemon has them and tees them into
 * ace-media's recorder (`tee-recordings.ts`), so ace-media always hands a source it ingests back
 * on egress. A still is ace-media's for a source it has, else the source's own capture.
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

/** Who delivers a source's pictures to viewers: ace-media, or nobody while it can't. */
export type DelivererPlace = "ace-media" | "none";

export type SourceRoute = {
  producer: "daemon" | "ace-media";
  /** The daemon copies the frames it receives into ace-media's ingest. */
  tee: boolean;
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
  // The daemon forwards an Android device's scrcpy units itself, on every platform.
  const ingest = [...builtRouteCapabilities.ingest, "scrcpy"] as const;
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

/** The route for one source kind. Anything but a healthy ace-media makes every `auto` legacy. */
export function sourceRoute(
  kind: SourceKind,
  settings: MediaSettings,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): SourceRoute {
  const healthy = health === "healthy";
  const producer =
    settings.encode === "auto" && healthy && capabilities.ingest.includes(kind)
      ? "ace-media"
      : "daemon";
  // ace-media delivers what its producer streams into it; the tee never feeds viewers.
  const deliverer = producer === "ace-media" && capabilities.delivery ? "ace-media" : "none";
  return {
    producer,
    // Recordings tee on their own (`tee-recordings.ts`); no viewer is fed by a tee.
    tee: false,
    // The daemon takes a recording's frames itself until X2 (see above).
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
  settings: MediaSettings,
  health: MediaHealth,
  capabilities: RouteCapabilities,
): string | undefined {
  if (sourceRoute(kind, settings, health, capabilities).deliverer === "ace-media") return undefined;
  if (health === "restarting") return "Live video is starting. It shows in a moment.";
  if (health === "unavailable")
    return "Live video stopped: ace's media process keeps failing on this computer. Restart ace to try again.";
  return "This computer can't stream this live view yet.";
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
      a.deliverer !== b.deliverer
    );
  });
}
