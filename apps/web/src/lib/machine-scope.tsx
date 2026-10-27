import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { useMemo, type ReactNode } from "react";
import { ScopedMachines, useMachines, type Machine } from "./machines.ts";

/**
 * Each other machine gets its own query cache, so a cached read from one machine can never show
 * on another's page. This window's daemon keeps the app's cache.
 */
const caches = new WeakMap<object, QueryClient>();
/** The query cache `MachineScope` keeps for the machine reached through `client`. */
export function machineCache(client: object, app: QueryClient): QueryClient {
  let cache = caches.get(client);
  if (!cache) {
    cache = new QueryClient({ defaultOptions: app.getDefaultOptions() });
    caches.set(client, cache);
  }
  return cache;
}

/**
 * Renders `children` against one machine: its client and its own query cache, so every hook
 * below reads and writes that machine and nothing falls back to another. While the machine is
 * offline it renders `unavailable` instead, so nothing stale or borrowed shows. The machine
 * list below stays the one read here, against this window's own daemon.
 */
export function MachineScope(props: {
  machine: Machine;
  unavailable?: ReactNode;
  children: ReactNode;
}) {
  const { machine } = props;
  const app = useQueryClient();
  const batch = useNotifyBatch();
  const machines = useMachines();
  const scoped = useMemo(() => ({ machines, machine }), [machines, machine]);
  if (machine.primary) return props.children;
  if (!machine.client) return props.unavailable ?? null;
  return (
    <ClientProvider client={machine.client} batch={batch}>
      <QueryClientProvider client={machineCache(machine.client, app)}>
        <ScopedMachines value={scoped}>{props.children}</ScopedMachines>
      </QueryClientProvider>
    </ClientProvider>
  );
}
