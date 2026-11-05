import { ClientError, type ClientApi, type Storage } from "@ace/client";
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

/** What an account machine's client is made from: its relay route, for one attempt. */
type AccountMachineRoute = Parameters<AccountMachineOptions["client"]>[0];

/** What a send queued before outboxes were kept per account says, once carried over. */
export const legacyOutboxError =
  "Saved before ace kept queued work per account, so it wasn't sent. Send it again or discard it.";

/** A saved outbox's entries, or none when it can't be read. */
function entriesOf(text: string | null): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Carries an older build's outbox for this machine (one per machine, no account) into an
 * account's. Nothing in it says which account queued it, so none of it is sent on its own: work
 * still waiting becomes a failed send, kept for the person to send again or discard under the
 * account they are now on. Work already done is dropped. Returns the merged value, or the
 * current one when the old outbox can't be read.
 */
function carryLegacy(legacy: string, current: string | null): string | null {
  const kept = entriesOf(current);
  const ids = new Set(kept.map(commandId));
  const carried = entriesOf(legacy).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("state" in entry)) return [];
    const id = commandId(entry);
    if (id === undefined || ids.has(id)) return [];
    if (entry.state === "failed") return [entry];
    if (entry.state !== "saving" && entry.state !== "pending") return [];
    return [{ ...entry, state: "failed", error: legacyOutboxError }];
  });
  return carried.length === 0 ? current : JSON.stringify([...kept, ...carried]);
}

function commandId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("command" in entry)) return undefined;
  const command: unknown = entry.command;
  if (typeof command !== "object" || command === null || !("id" in command)) return undefined;
  return typeof command.id === "string" ? command.id : undefined;
}

/**
 * An account machine's outbox, kept for this window so a reload doesn't drop queued work. It is
 * kept per account as well as per machine: work queued under one account is only ever sent
 * under that account, and waits for it rather than being dropped if the window signs in to
 * another one and back. With no account there is nothing to keep.
 */
function outbox(storage: KeyValueStorage, accountId: string | undefined, hostId: string): Storage {
  if (accountId === undefined) return { load: async () => null, save: async () => {} };
  const key = `ace.account.outbox:${encodeURIComponent(accountId)}:${hostId}`;
  const legacyKey = `ace.account.outbox:${hostId}`;
  return {
    load: async () => {
      const legacy = storage.getItem(legacyKey);
      if (legacy !== null) {
        const merged = carryLegacy(legacy, storage.getItem(key));
        if (merged !== null) storage.setItem(key, merged);
        storage.removeItem?.(legacyKey);
      }
      return storage.getItem(key);
    },
    save: async (value) => storage.setItem(key, value),
  };
}

/**
 * A client for an account machine, for `owner`'s work only: its outbox is `owner`'s, and should
 * the window hold another account when it dials again, it never does, so that work is never
 * sent under another account. `owner` undefined: a client made while signed out, with nothing
 * to keep.
 */
export function accountMachineClient(
  session: KeyValueStorage,
  origin: string,
  owner: string | undefined,
  route: AccountMachineRoute,
): ClientApi {
  const holder = () => windowAccountSession(session, origin)?.account.id;
  const owned = () => {
    if (holder() !== owner)
      throw new ClientError("auth", "This machine was opened on your other ace account.");
  };
  return createBrowserClient({
    deviceId: route.deviceId,
    transport: route.transport,
    credential: async () => {
      owned();
      return route.credential();
    },
    // A grant refresh is never sent under another account either.
    grant: async () => {
      owned();
      return route.grant();
    },
    expectedHostId: route.expectedHostId,
    storage: outbox(session, owner, route.hostId),
  });
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
    // The network changed: a better path may be back, or the active one gone.
    watchNetwork: (changed) => {
      addEventListener("online", changed);
      return () => removeEventListener("online", changed);
    },
    clock: () => performance.now(),
    // A direct path only where the browser checks the machine's certificate (ADR 0114).
    directRoute: (path, credential) =>
      browserChecksDirect(path)
        ? {
            transport: () => checkedSocketTransport(path.url),
            credential,
            probe: httpsProbe(path.url, () => performance.now()),
          }
        : undefined,
    // The pool opens machines for the account the window holds as it opens them.
    client: (route) =>
      accountMachineClient(
        options.session,
        origin,
        windowAccountSession(options.session, origin)?.account.id,
        route,
      ),
  };
}
