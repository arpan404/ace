import { ClientError, type Storage } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import { browserDeviceSocket } from "@ace/client/devices";
import type { AccountMachineOptions } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import {
  accountDeviceId,
  accountOrigin,
  hostedRelayUrl,
  windowAccountSession,
} from "./account-config.ts";
import { createBrowserClient } from "./client.ts";
import { authorizeDaemonUrl } from "./daemon-network.ts";
import { browserChecksDirect, checkedSocketTransport, httpsProbe } from "./machine-routes.ts";

/** An account machine's outbox, kept for this window so a reload doesn't drop queued work. */
function outbox(storage: KeyValueStorage, hostId: string): Storage {
  const key = `ace.account.outbox:${hostId}`;
  return {
    load: async () => storage.getItem(key),
    save: async (value) => storage.setItem(key, value),
  };
}

/**
 * How the machine pool opens machines on the person's ace account (ADR 0111): through ace's
 * hosted relay, with a fresh device grant from the account backend for every attempt and the
 * ace session this window holds at that moment. Undefined in a build without ace accounts.
 */
export function accountMachineOptions(options: {
  /** Long-lived storage: this browser's device id on the account. */
  storage: KeyValueStorage;
  /** This window's storage: its ace session and the machines' outboxes. */
  session: KeyValueStorage;
}): AccountMachineOptions | undefined {
  const origin = accountOrigin();
  const relayUrl = hostedRelayUrl();
  if (!origin || !relayUrl) return undefined;
  const account = aceAccountClient({
    origin,
    fetch: async (input, init) => {
      await authorizeDaemonUrl(`${origin}/`);
      return fetch(input, init);
    },
  });
  const deviceId = accountDeviceId(options.storage, () => crypto.randomUUID());
  return {
    relayUrl,
    deviceId,
    async grant() {
      const session = windowAccountSession(options.session, origin);
      if (!session) throw new ClientError("auth", "Sign in to your ace account again.");
      // The desktop app admits only addresses the person chose; the relay is one of them.
      await authorizeDaemonUrl(relayUrl);
      const grant = await account.grant(
        session.token,
        { kind: "device", subject: deviceId },
        AbortSignal.timeout(15_000),
      );
      return grant.token;
    },
    socket: browserDeviceSocket,
    // A direct path only where the browser checks the machine's certificate (ADR 0114).
    directRoute: (path, credential) =>
      browserChecksDirect(path)
        ? {
            transport: () => checkedSocketTransport(path.url),
            credential,
            probe: httpsProbe(path.url, () => performance.now()),
          }
        : undefined,
    client: (route) =>
      createBrowserClient({
        deviceId: route.deviceId,
        transport: route.transport,
        credential: route.credential,
        expectedHostId: route.expectedHostId,
        storage: outbox(options.session, route.hostId),
      }),
  };
}
