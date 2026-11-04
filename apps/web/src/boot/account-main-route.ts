import { machineCodeGate, relayRoute } from "@ace/client";
import { AceAccountError, aceAccountClient } from "@ace/client/ace-account";
import type { AccountMachineOptions } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import { accountOrigin, accountSessionKey } from "./account-config.ts";
import { accountMachineOptions } from "./account-machine-options.ts";
import { accountSecret } from "./account-secret.ts";
import { authorizeDaemonUrl } from "./daemon-network.ts";
import type { AccountMainMachine, AccountMainRoute, AccountRouteSource } from "./main-machine.ts";
import { trackedGrant } from "./tracked-grant.ts";

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * One account machine's route as this window's machine: its machine code gate, kept across
 * attempts so a code typed on the connection screen goes with the next one, and a client per
 * attempt, through ace's relay pinned to its host id, with a fresh grant each time it dials.
 */
export function accountMainRoute(
  machine: AccountMainMachine,
  options: Pick<AccountMachineOptions, "relayUrl" | "deviceId" | "grant" | "socket" | "client">,
): AccountMainRoute {
  const grants = trackedGrant(() => options.grant());
  const code = machineCodeGate(() => grants.grant());
  return {
    code,
    deviceId: options.deviceId,
    grantProblem: grants.problem,
    client() {
      const route = relayRoute({
        relayUrl: options.relayUrl,
        hostId: machine.hostId,
        credential: () => code.credential(),
        socket: options.socket,
        schedule,
        refused: (reason, _message, lockedUntil) => code.refused(reason, lockedUntil),
        welcomed: () => code.welcomed(),
      });
      return options.client({
        hostId: machine.hostId,
        deviceId: options.deviceId,
        transport: route.transport,
        credential: route.credential,
      });
    },
  };
}

/**
 * How this window opens a machine on the ace account as its own (ADR 0111), with the account
 * options the machine pool uses. The desktop app keeps the ace session in its own secure store
 * and copies it into the window only once Settings has restored it, so before the first grant
 * the window takes it from there itself. Loaded on demand (`main.tsx`). Without ace accounts in this build, or for a machine
 * chosen on another account backend, there is no route.
 */
export function browserAccountRoutes(options: {
  storage: KeyValueStorage;
  session: KeyValueStorage;
}): AccountRouteSource {
  return async (machine) => {
    const origin = accountOrigin();
    const account = accountMachineOptions(options);
    if (!origin || !account || origin !== machine.origin) return undefined;
    const secure = accountSecret();
    const key = accountSessionKey(origin);
    const backend = aceAccountClient({
      origin,
      fetch: async (input, init) => {
        await authorizeDaemonUrl(`${origin}/`);
        return fetch(input, init);
      },
    });
    const restore = async () => {
      if (!secure || options.session.getItem(key) !== null) return;
      const token = await secure.read(origin).catch(() => null);
      if (!token) return;
      const session = await backend.session(token, AbortSignal.timeout(15_000));
      options.session.setItem(key, JSON.stringify({ ...session, token }));
    };
    const grant = async () => {
      try {
        await restore();
        return await account.grant();
      } catch (error) {
        // The session ended: this window is signed out everywhere, not only for this machine.
        if (error instanceof AceAccountError && error.status === 401) {
          options.session.removeItem?.(key);
          await secure?.write(origin, null).catch(() => {});
        }
        throw error;
      }
    };
    return accountMainRoute(machine, { ...account, grant });
  };
}
