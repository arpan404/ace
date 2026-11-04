import { ClientError, machineCodeGate, type Transport } from "@ace/client";
import { fakeTransport, type FakeDaemon } from "@ace/fake-daemon";
import type { KeyValueStorage } from "@ace/ui-core";
import { accountSessionKey } from "./account-config.ts";
import { createBrowserClient, memoryStorage } from "./client.ts";
import { fakeMachineCodes, fakeOrigin } from "./fake-account.ts";
import type { AccountRouteSource } from "./main-machine.ts";
import { trackedGrant } from "./tracked-grant.ts";

/**
 * Fake mode's and tests' way to open a machine on the fake ace account as the window's own:
 * the fake daemon behind a stand-in for ace's relay that refuses as the relay does. A grant
 * needs the window's ace session (signed out: 4001), a host id in `removed` has left the
 * account (4403), and the Studio wants its machine code (4011) as `fakeMachineCodes` says.
 */
export function fakeAccountRoutes(options: {
  daemon: FakeDaemon;
  /** This window's storage, holding its fake ace session. */
  session: KeyValueStorage;
  now(): number;
  removed?: ReadonlySet<string> | undefined;
}): AccountRouteSource {
  const codes = fakeMachineCodes(options.now);
  return async (machine) => {
    if (machine.origin !== fakeOrigin) return undefined;
    const grants = trackedGrant(async () => {
      if (options.session.getItem(accountSessionKey(fakeOrigin)) === null)
        throw new ClientError("auth", "Sign in to your ace account again.");
      return "fake-grant";
    });
    const code = machineCodeGate(() => grants.grant());
    const relay = (): Transport => {
      const daemon = fakeTransport(options.daemon);
      let epoch = 0;
      return {
        open(events) {
          const stamp = ++epoch;
          void code.credential().then(
            ({ machineCode }) => {
              if (stamp !== epoch) return;
              if (options.removed?.has(machine.hostId))
                return events.close(4403, "This machine isn't on your ace account.");
              const refused = codes.check(machine.hostId, machineCode);
              if (refused) {
                code.refused(refused, codes.lockedUntil);
                return events.close(4011, refused);
              }
              code.welcomed();
              daemon.open(events);
            },
            () => {
              if (stamp === epoch) events.close(4001, "Credential refused");
            },
          );
        },
        send: (text) => daemon.send(text),
        close() {
          epoch++;
          daemon.close();
        },
      };
    };
    return {
      code,
      deviceId: "fake-account-device",
      grantProblem: grants.problem,
      client: () =>
        createBrowserClient({
          deviceId: "fake-account-device",
          transport: relay,
          credential: async () => options.daemon.token,
          storage: memoryStorage(),
        }),
    };
  };
}
