import type { KeyValueStorage } from "@ace/ui-core";
import { fakeAccountBackend, fakeOrigin } from "./fake-account.ts";

/** The fake account backend, signed in as the fake person or, with `signedOut`, not. */
export function fakeNoMachineAccount(session: KeyValueStorage, signedOut: boolean) {
  return () => {
    const made = fakeAccountBackend(session, Date.now);
    if (signedOut) session.removeItem?.(`ace.account.session:${fakeOrigin}`);
    return made;
  };
}
