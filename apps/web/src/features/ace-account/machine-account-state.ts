import type { MachineAccountStatus } from "@ace/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAceAccount, useAceAccountStore } from "./account-context.tsx";
import { machineAccountRow } from "./machine-account-copy.ts";

/** A machine's ace account and machine code: read, sign in or out, set or clear the code. */
export interface MachineAccountAccess {
  /** Undefined from a daemon too old to have ace accounts. */
  status(): Promise<MachineAccountStatus | undefined>;
  /** Signs the machine in with this app's session. */
  signIn(origin: string, token: string): Promise<MachineAccountStatus>;
  signOut(): Promise<MachineAccountStatus>;
  setCode(code: string): Promise<MachineAccountStatus>;
  clearCode(): Promise<MachineAccountStatus>;
}

const statusKey = (machine: string) => ["ace-account", "machine", machine] as const;

/**
 * A machine's ace account and machine code as its daemon reports them, and a way to replace
 * what's cached after a change. `data` is null from a daemon without ace accounts.
 */
export function useMachineAccountStatus(machine: string, access: MachineAccountAccess | undefined) {
  const queryClient = useQueryClient();
  const key = statusKey(machine);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (access ? ((await access.status()) ?? null) : null),
    enabled: access !== undefined,
    retry: false,
  });
  return {
    query,
    write: (next: MachineAccountStatus) => queryClient.setQueryData(key, next),
  };
}

/**
 * Signing this computer's daemon in with the app's ace session, or out: the sentence and the
 * action its row offers (`machineAccountRow`), and the change.
 */
export function useThisMachineAccount(
  status: MachineAccountStatus | null | undefined,
  access: MachineAccountAccess | undefined,
  onChange: (next: MachineAccountStatus) => void,
) {
  const store = useAceAccountStore();
  const { session } = useAceAccount();
  const row = status ? machineAccountRow(status, session?.account) : undefined;
  const change = useMutation({
    mutationFn: (op: "signIn" | "signOut") => {
      if (!access) throw new Error("Reconnect to change this machine's account.");
      if (op === "signOut") return access.signOut();
      if (!store || !session) throw new Error("Sign in to your ace account under Profile first.");
      return access.signIn(store.origin, session.token);
    },
    onSuccess: onChange,
  });
  return { row, change };
}
