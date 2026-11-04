import type { KeyValueStorage } from "@ace/ui-core";
import { fallback, type DaemonConnection } from "./connection.tsx";
import { defaultDaemonUrl } from "./connection-settings.ts";
import { fakeAccountBackend, fakeOrigin } from "./fake-account.ts";

/**
 * Fake mode's window with no machine (`?machine=none`): nothing chosen, and choosing a machine
 * opens the fake daemon's own app.
 */
export const fakeNoMachineConnection: DaemonConnection = {
  ...fallback,
  mode: "daemon",
  url: defaultDaemonUrl,
  status: { kind: "editing" },
  connect: () => location.assign("/"),
};

/** The fake account backend, signed in as the fake person or, with `signedOut`, not. */
export function fakeNoMachineAccount(session: KeyValueStorage, signedOut: boolean) {
  return () => {
    const made = fakeAccountBackend(session, Date.now);
    if (signedOut) session.removeItem?.(`ace.account.session:${fakeOrigin}`);
    return made;
  };
}
