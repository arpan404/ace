import { appInstallId, uuidV7 } from "@ace/client/install-id";
import type { KeyValueStorage } from "@ace/ui-core";

/**
 * This browser's (or desktop app's) install id (ADR 0115), kept in its origin's local storage:
 * the desktop app's `app://ace` origin lives in its userData, so it lasts as long as the app.
 * Boundary code: the clock and randomness are read here.
 */
export function browserInstallId(storage: KeyValueStorage = localStorage): string {
  return appInstallId(storage, () =>
    uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
  );
}
