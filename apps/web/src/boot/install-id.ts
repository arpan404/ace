import { installIdentity, uuidV7 } from "@ace/client/install-id";
import type { KeyValueStorage } from "@ace/ui-core";

/** One resolved identity per storage for this run, so every caller names the same install. */
const identities = new WeakMap<KeyValueStorage, () => string>();

/**
 * This browser's (or desktop app's) install id (ADR 0115), kept in its origin's local storage:
 * the desktop app's `app://ace` origin lives in its userData, so it lasts as long as the app.
 * Boundary code: the clock and randomness are read here.
 */
export function browserInstallId(storage: KeyValueStorage = localStorage): string {
  let identity = identities.get(storage);
  if (!identity) {
    identity = installIdentity(storage, () =>
      uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
    );
    identities.set(storage, identity);
  }
  return identity();
}
