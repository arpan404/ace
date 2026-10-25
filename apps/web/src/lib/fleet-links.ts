import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { FleetLink } from "@ace/protocol";
import { useQuery } from "@tanstack/react-query";
import { usePrimaryMachine } from "./machines.ts";

/** The query key of one machine's links to the person's other machines (ADR 0078). */
export const fleetLinksKey = (machine: string) => ["fleet", "links", machine] as const;

/** One machine's links to other machines, through that machine's own client. */
export async function machineLinks(client: ClientApi): Promise<FleetLink[]> {
  const reply = await client.request({ type: "fleet.request", operation: { op: "links" } });
  return reply.result.kind === "links" ? reply.result.links : [];
}

/**
 * Whether this machine is linked to another one, so "Continue on…" and "Open on…" have somewhere
 * to go (ADR 0101). With no other machine they aren't offered at all.
 */
export function useHasLinkedMachines(): boolean {
  const client = useClient();
  const own = usePrimaryMachine();
  const links = useQuery({
    queryKey: fleetLinksKey(own.id),
    queryFn: () => machineLinks(client),
    staleTime: 60_000,
  });
  return (links.data ?? []).some((link) => link.hostId !== undefined);
}
