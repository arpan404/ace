import { machineThreadKey } from "@ace/client/machines";
import { accountView, type AccountView } from "@ace/ui-core";
import { useQuery } from "@tanstack/react-query";
import { useMachineThread } from "./machine-threads.ts";
import { useMachines } from "./machines.ts";

/*
 * Accounts on another paired machine (ADR 0059). `useAccountViews` reads this window's daemon
 * (or the scoped machine's); a child running elsewhere is signed in to that machine's accounts,
 * whose ids can repeat this one's, so they are read from that machine's own client.
 */

/** How long one machine's account list is reused before a new reader refreshes it. */
const freshMs = 5 * 60_000;

/**
 * Every account machine `hostId` lists, read through its client in the pool: one request per
 * machine, shared by every reader through the app's query cache. Undefined while it loads, and
 * while the machine is offline with nothing read yet.
 */
export function useMachineAccountViews(hostId: string): readonly AccountView[] | undefined {
  const machine = useMachines().find((each) => each.id === hostId);
  const client = machine?.client;
  const query = useQuery({
    queryKey: ["machine", hostId, "accounts"],
    enabled: client !== undefined,
    staleTime: freshMs,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error(`${hostId} is offline`);
      const reply = await client.request({ type: "accounts.list" }, { signal });
      return reply.accounts.map(accountView);
    },
  });
  return query.data;
}

/** The account thread `threadId` on machine `hostId` runs on, as the pool last heard it. */
export function useMachineThreadAccount(hostId: string, threadId: string): string | undefined {
  const thread = useMachineThread(machineThreadKey({ hostId, threadId }));
  return thread?.execution?.instanceId ?? thread?.live?.account;
}
