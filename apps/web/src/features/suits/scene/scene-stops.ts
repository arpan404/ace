import type { SuitDetail } from "@ace/protocol/suits";
import type { SuitSceneRegion } from "@ace/protocol/suit-parts";
import type { SceneStop } from "./scene-controller.ts";

/*
 * Which region scenes run, by version of the Suit (its id and content hash, the daemon's checksum
 * of its files), not by URL (ADR 0150). A read of the same version is the same scene: a frame
 * already running keeps running across a reconnect, whatever URL the new read carries.
 *
 * A scene that throws or is too slow is down for that version: only an edit brings it back. A
 * scene that never said it was ready may just not have loaded (its URL belonged to a daemon
 * that was gone), so it gets another go with the next read of the Suit, in a new frame. Pure.
 */

/** One version of one Suit's scene in one region. */
export const sceneKey = (suit: SuitDetail, region: SuitSceneRegion) =>
  `${suit.summary.id}\u0000${suit.summary.contentHash}\u0000${region}`;

export interface SceneStops {
  /** Scenes down for their version. */
  readonly down: ReadonlySet<string>;
  /** Scenes that never became ready: the read they failed under and how many frames failed. */
  readonly unready: ReadonlyMap<string, { readonly read: SuitDetail; readonly tries: number }>;
}

export const noStops: SceneStops = { down: new Set(), unready: new Map() };

/** The stops after `suit`'s scene in `region` stopped for `why`. */
export function withStop(
  stops: SceneStops,
  suit: SuitDetail,
  region: SuitSceneRegion,
  why: SceneStop,
): SceneStops {
  const key = sceneKey(suit, region);
  if (why.reason !== "no-ready") return { ...stops, down: new Set(stops.down).add(key) };
  const tries = (stops.unready.get(key)?.tries ?? 0) + 1;
  return { ...stops, unready: new Map(stops.unready).set(key, { read: suit, tries }) };
}

/**
 * The frame `region` shows for this read of the Suit: a key that changes only when a new frame is
 * due (another version, or another go after a frame that never loaded), or null while it's down.
 */
export function sceneFrame(
  stops: SceneStops,
  suit: SuitDetail,
  region: SuitSceneRegion,
): string | null {
  const key = sceneKey(suit, region);
  if (stops.down.has(key)) return null;
  const unready = stops.unready.get(key);
  if (unready?.read === suit) return null;
  return `${key}\u0000${unready?.tries ?? 0}`;
}
