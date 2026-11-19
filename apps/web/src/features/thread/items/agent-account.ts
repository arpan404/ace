import { useSidebarThread } from "@ace/client-react";
import { useThreadField, type ThreadRecord } from "@ace/client-react/thread-field";
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

/** The account a thread runs on. */
const accountOf = (thread: ThreadRecord) => thread.execution?.instanceId ?? thread.live?.account;

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
  const parent = useThreadField(input.childThreadId ? undefined : input.threadId, accountOf);
  const here = useSidebarThread(input.elsewhere ? "" : child);
  const host = input.elsewhere ? (input.host ?? "") : "";
  const remote = useMachineThreadAccount(host, host ? child : "");
  const remoteAccounts = useMachineAccountViews(host);
  if (input.elsewhere)
    return { instance: host ? remote : undefined, accounts: remoteAccounts ?? none };
  if (!input.childThreadId) return { instance: parent };
  return { instance: here?.execution?.instanceId ?? here?.live?.account };
}

const none: readonly AccountView[] = [];
