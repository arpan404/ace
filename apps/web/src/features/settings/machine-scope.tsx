import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClientProvider, useNotifyBatch } from "@ace/client-react";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { useMachines, type Machine } from "@/lib/machines.ts";

/*
 * Which machine Settings edits. Settings that a daemon keeps (agents, providers, source
 * control, browser, storage…) belong to one machine; the person picks it once in the Settings
 * sidebar and every machine page follows. Pages that only this device keeps ignore it.
 */

interface SettingsMachine {
  /** The machine Settings edits; undefined only while the chosen one has left the pool. */
  machine: Machine | undefined;
  /** Every machine, this window's own daemon first. */
  machines: readonly Machine[];
  /** Pick a machine by host id; undefined picks this window's own daemon. */
  choose(id: string | undefined): void;
  /** The chosen machine is no longer paired, so nothing may stand in for it. */
  missing: boolean;
  /** "All machines": pages read this window's machine and write to every connected one. */
  all: boolean;
}

const ChosenMachine = createContext<SettingsMachine | undefined>(undefined);

/**
 * Holds the chosen machine while Settings is open; leaving Settings forgets it. The machine
 * list is read here, against this window's own daemon, so a page rendered against another
 * machine still sees the same list and the same choice.
 */
export function SettingsMachineProvider(props: { children: ReactNode; initial?: string }) {
  const [id, choose] = useState<string | undefined>(props.initial);
  const machines = useMachines();
  const all = id === allMachines;
  const machine = id === undefined || all ? machines[0] : machines.find((entry) => entry.id === id);
  const missing = id !== undefined && !all && !machine;
  const value = useMemo(
    () => ({ machine, machines, choose, missing, all }),
    [machine, machines, missing, all],
  );
  return <ChosenMachine value={value}>{props.children}</ChosenMachine>;
}

/**
 * The machine Settings edits: the chosen one, else this window's own daemon. `missing` is set
 * when the chosen machine has left the pool, so a page never falls back to another machine.
 */
export function useSettingsMachine(): SettingsMachine {
  return use(ChosenMachine) ?? outsideSettings;
}

/** A page rendered on its own, outside Settings' frame: nothing to pick. */
const outsideSettings: SettingsMachine = {
  machine: undefined,
  machines: [],
  choose: () => {},
  missing: false,
  all: false,
};

/** The choice that makes Machine pages edit every connected machine at once. */
export const allMachines = "all";

/**
 * Each other machine gets its own query cache, so a cached read from one machine can never show
 * on another's page. This window's daemon keeps the app's cache.
 */
const caches = new WeakMap<object, QueryClient>();
function machineCache(client: object, app: QueryClient): QueryClient {
  let cache = caches.get(client);
  if (!cache) {
    cache = new QueryClient({ defaultOptions: app.getDefaultOptions() });
    caches.set(client, cache);
  }
  return cache;
}

/**
 * Renders `children` against one machine: its client and its own query cache. While the machine
 * is offline it renders `unavailable` instead, so nothing stale or borrowed shows.
 */
export function MachineScope(props: {
  machine: Machine;
  unavailable?: ReactNode;
  children: ReactNode;
}) {
  const { machine } = props;
  const app = useQueryClient();
  const batch = useNotifyBatch();
  if (machine.primary) return props.children;
  if (!machine.client) return props.unavailable ?? null;
  return (
    <ClientProvider client={machine.client} batch={batch}>
      <QueryClientProvider client={machineCache(machine.client, app)}>
        {props.children}
      </QueryClientProvider>
    </ClientProvider>
  );
}

/** Why a machine's settings can't show right now, in one line. */
export function machineUnavailableText(machine: Machine): string {
  if (machine.status === "auth_failed")
    return "This device's access was refused. Pair it again from Machines and devices.";
  if (machine.status === "connecting") return "Connecting. Its settings appear once it answers.";
  return "Its settings appear when it's back online.";
}
