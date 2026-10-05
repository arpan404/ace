import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * When this device first opened Home: activity before it counts as seen, so a first launch
 * isn't all unread. Kept in the organizer's record (`organizer.ts`), which reads it from here,
 * so Home and the rail's Home mark judge unread against the same moment. zod/mini: the rail
 * reads it on the first paint.
 */

const key = "ace.home.organizer";
const Baseline = z.object({ baseline: z.number() });

/** This device's first launch, recorded at `now` the first time anything asks. */
export function firstLaunch(storage: KeyValueStorage | undefined, now: number): number {
  const stored = readJson(storage, key, Baseline, undefined);
  if (stored) return stored.baseline;
  writeJson(storage, key, { baseline: now });
  return now;
}
