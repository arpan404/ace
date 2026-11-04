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

/**
 * An account machine's outbox, kept for this window so a reload doesn't drop queued work. It is
 * kept per account as well as per machine: work queued under one account is only ever sent
 * under that account, and waits for it rather than being dropped if the window signs in to
 * another one and back. With no account there is nothing to keep.
 */
function outbox(storage: KeyValueStorage, accountId: string | undefined, hostId: string): Storage {
  if (accountId === undefined) return { load: async () => null, save: async () => {} };
  const key = `ace.account.outbox:${encodeURIComponent(accountId)}:${hostId}`;
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
    client(route) {
      // The account this client is for. Should the window's account change before the pool or
      // the gate closes it, it never dials again, so its outbox is never sent under another.
      const accountId = () => windowAccountSession(options.session, origin)?.account.id;
      const owner = accountId();
      return createBrowserClient({
        deviceId: route.deviceId,
        transport: route.transport,
        credential: async () => {
          if (accountId() !== owner)
            throw new ClientError("auth", "This machine was opened on your other ace account.");
          return route.credential();
        },
        storage: outbox(options.session, owner, route.hostId),
      });
    },
  };
}
