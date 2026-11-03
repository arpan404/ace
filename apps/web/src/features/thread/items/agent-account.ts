import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import type { AccountView } from "@ace/ui-core";
import { useMachineAccountViews, useMachineThreadAccount } from "@/lib/machine-accounts.ts";

/** The account an agent row's mark wears, and the list it belongs to. */
export interface AgentAccount {
  /** The account's id, once known. */
  instance?: string | undefined;
  /**
   * The accounts `instance` is one of: another machine's, empty until they load. Undefined for
   * an agent here, whose account is one of this window's.
   */
  accounts?: readonly AccountView[] | undefined;
}

/**
 * The account an agent runs on. A subagent runs on its parent thread's account; a delegated
 * thread on its own, here or on the machine it runs on (`host`, a host id in the pool). A
 * child on a machine this window can't name has no account to show.
 */
export function useAgentAccount(input: {
  threadId: string;
  childThreadId?: string | undefined;
  /** It runs on another machine. */
  elsewhere: boolean;
  /** That machine's host id, when the pool has it. */
  host?: string | undefined;
}): AgentAccount {
  const child = input.childThreadId ?? "";
  const parent = useThreadMeta(input.childThreadId ? undefined : input.threadId);
  const here = useSidebarThread(input.elsewhere ? "" : child);
  const host = input.elsewhere ? (input.host ?? "") : "";
  const remote = useMachineThreadAccount(host, host ? child : "");
  const remoteAccounts = useMachineAccountViews(host);
  if (input.elsewhere)
    return { instance: host ? remote : undefined, accounts: remoteAccounts ?? none };
  const source = input.childThreadId ? here : parent;
  return { instance: source?.execution?.instanceId ?? source?.live?.account };
}

const none: readonly AccountView[] = [];
