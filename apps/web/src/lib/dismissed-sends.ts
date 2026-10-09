import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";
import { Observable } from "./observable.ts";

/*
 * Failed sends the person has acted on (Retry sent a new one, Edit took it back). The outbox
 * keeps failed intents for a while, also across reloads, so the choice is kept on this device.
 */
const dismissedKey = "ace.sends.dismissed";
const dismissedLimit = 200;
const Dismissed = z.array(z.string());
let dismissedLoaded: ReadonlySet<string> | undefined;
export const dismissedSends = new Observable<ReadonlySet<string>>(new Set());

export function loadDismissed(storage: KeyValueStorage | undefined): ReadonlySet<string> {
  if (!dismissedLoaded) {
    dismissedLoaded = new Set(readJson(storage, dismissedKey, Dismissed, []));
    dismissedSends.seed(dismissedLoaded);
  }
  return dismissedSends.get();
}

export function dismissSend(storage: KeyValueStorage | undefined, commandId: string): void {
  const next = new Set(loadDismissed(storage));
  next.add(commandId);
  const kept = [...next].slice(-dismissedLimit);
  dismissedLoaded = new Set(kept);
  dismissedSends.set(dismissedLoaded);
  writeJson(storage, dismissedKey, kept);
}

/** Test seam. */
export function resetDismissed(): void {
  dismissedLoaded = undefined;
  dismissedSends.set(new Set());
}
