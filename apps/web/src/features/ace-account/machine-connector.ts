import type {
  AccountMachine,
  AccountMachineConnection,
  AccountMachineState,
} from "@ace/client-worker/machines";
import { createContext, use, useMemo } from "react";
import { hostedRelayUrl } from "@/boot/account-config.ts";
import { useEnsureMachinePool, useMachinePool } from "@/lib/machine-pool.ts";
import { useAceAccount } from "./account-context.tsx";

export type { AccountMachineConnection, AccountMachineState };

/**
 * Opens a machine on the person's ace account through ace's relay (ADR 0111). Once open it is
 * in the machine pool like a paired machine; the connection's gate asks for its machine code.
 */
export interface AccountMachineConnector {
  connect(machine: AccountMachine): Promise<AccountMachineConnection>;
}

/** A connector supplied from outside (the fake mode's); otherwise the machine pool's. */
export const AccountMachineConnectorContext = createContext<AccountMachineConnector | undefined>(
  undefined,
);

/**
 * The window's account machine connector: the machine pool's `openAccountMachine`, created on
 * demand, while this window is signed in to an account build with a hosted relay.
 */
export function useAccountMachineConnector(): AccountMachineConnector | undefined {
  const supplied = use(AccountMachineConnectorContext);
  const pool = useMachinePool();
  const ensure = useEnsureMachinePool();
  const signedIn = useAceAccount().session !== null;
  return useMemo(() => {
    if (supplied) return supplied;
    if (!signedIn || !hostedRelayUrl() || (!pool && !ensure)) return undefined;
    return {
      async connect(machine) {
        const ready = pool ?? (await ensure?.());
        if (!ready) throw new Error("Couldn't open your machines in this window.");
        return ready.openAccountMachine(machine);
      },
    };
  }, [supplied, pool, ensure, signedIn]);
}
