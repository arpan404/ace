import { ClientProvider, useClient, useNotifyBatch } from "@ace/client-react";
import { useMemo, type ReactNode } from "react";
import type { Machine } from "@/lib/machines.ts";
import { AllMachinesClients, fanOutClient } from "./data/all-machines.ts";

/**
 * A page against every connected machine: it reads this window's own machine, and each settings
 * write goes to all of them (`fanOutClient`).
 */
export function AllMachinesScope(props: { machines: readonly Machine[]; children: ReactNode }) {
  const primary = useClient();
  const batch = useNotifyBatch();
  const online = props.machines.flatMap((entry) =>
    !entry.primary && entry.client ? [entry.client] : [],
  );
  // One client per set of connected machines: a status change elsewhere doesn't remake it.
  const onlineKey = props.machines
    .filter((entry) => !entry.primary && entry.client)
    .map((entry) => entry.id)
    .join(",");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the connected machines
  const others = useMemo(() => online, [onlineKey]);
  const client = useMemo(() => fanOutClient(primary, others), [primary, others]);
  return (
    <ClientProvider client={client} batch={batch}>
      <AllMachinesClients value={others}>{props.children}</AllMachinesClients>
    </ClientProvider>
  );
}
