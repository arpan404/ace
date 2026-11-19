import { keepPreviousData, useQueries, useQueryClient } from "@tanstack/react-query";
import type { ClientApi } from "@ace/client";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { GroupableProject, MachineProjectList } from "@ace/ui-core/project-groups";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { useLayout } from "./layout.tsx";
import { useClock } from "./time.ts";
import { useMachines, type Machine } from "./machines.ts";
import { readProjects, type Project } from "./projects.ts";
import {
  applyPush,
  pushOf,
  pushesFor,
  type ProjectPush,
  type ProjectPushes,
} from "./project-pushes.ts";

/*
 * Every machine's projects for the logical project lists (ADR 0180): each online machine's
 * list as it reads now, kept live by its pushes, and each offline machine's last list, kept on
 * this device so a project only that machine has stays listed, marked offline.
 */

const storageKey = "ace.projects.lastSeen";
/** The most machines and projects per machine kept for when they are offline. */
const keptMachines = 16;
const keptProjects = 500;

const Kept = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256),
  path: z.string().max(4096),
  kind: z.string().max(32).optional(),
  identity: z
    .object({ id: z.string().max(64), aliases: z.array(z.string().max(64)).max(32) })
    .optional(),
  remoteKey: z
    .object({
      remotes: z.array(z.string().max(4096)).min(1).max(64),
      subpath: z.string().max(4096),
    })
    .optional(),
  openedAt: z.number().nonnegative().optional(),
});
const KeptList = z.object({ at: z.number(), projects: z.array(Kept).max(keptProjects) });
/** Each machine's list on its own: one that no longer reads is dropped, the others kept. */
const KeptLists = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((lists) =>
    Object.fromEntries(
      Object.entries(lists).flatMap(([id, list]) => {
        const parsed = KeptList.safeParse(list);
        return parsed.success ? [[id, parsed.data] as const] : [];
      }),
    ),
  );
type KeptLists = z.infer<typeof KeptLists>;

const keep = (project: GroupableProject) => ({
  id: project.id,
  name: project.name,
  path: project.path,
  ...(project.kind ? { kind: project.kind } : {}),
  ...(project.identity
    ? { identity: { id: project.identity.id, aliases: [...project.identity.aliases] } }
    : {}),
  ...(project.remoteKey
    ? { remoteKey: { remotes: [...project.remoteKey.remotes], subpath: project.remoteKey.subpath } }
    : {}),
  ...(project.openedAt === undefined ? {} : { openedAt: project.openedAt }),
});

/** Keep a machine's list as read now, the oldest machines dropped past the cap. */
export function rememberMachineProjects(
  storage: KeyValueStorage | undefined,
  machineId: string,
  projects: readonly GroupableProject[],
  at: number,
): void {
  const kept = readJson(storage, storageKey, KeptLists, {});
  const next: KeptLists = {
    ...kept,
    [machineId]: { at, projects: projects.slice(0, keptProjects).map(keep) },
  };
  const newest = Object.entries(next)
    .toSorted((a, b) => b[1].at - a[1].at)
    .slice(0, keptMachines);
  writeJson(storage, storageKey, Object.fromEntries(newest));
}

/**
 * Keep a pushed change in a machine's kept list too, so going offline right after it never
 * brings back the list from before it. `current` is the list held now, else the kept one is
 * patched; with neither there is nothing to keep it in yet.
 */
export function rememberMachinePush<P extends GroupableProject>(
  storage: KeyValueStorage | undefined,
  machineId: string,
  push: ProjectPush<P>,
  at: number,
  current?: readonly P[],
): P[] | undefined {
  if (current) {
    const next = applyPush(current, push);
    rememberMachineProjects(storage, machineId, next, at);
    return next;
  }
  const kept = keptMachineProjects(storage, machineId)?.projects;
  if (kept)
    rememberMachineProjects(storage, machineId, applyPush<GroupableProject>(kept, push), at);
  return undefined;
}

/** A machine's list as this device last saw it, with when. */
export function keptMachineProjects(
  storage: KeyValueStorage | undefined,
  machineId: string,
): { at: number; projects: GroupableProject[] } | undefined {
  return readJson(storage, storageKey, KeptLists, {})[machineId];
}

/**
 * A machine's list is read per socket: a list read before a disconnect may miss a change pushed
 * while this window couldn't hear (an unlink there), so a new socket is a new read. `socket`
 * names the client and its socket (`useSockets`).
 */
const poolKey = (machineId: string, socket: string) => ["poolProjects", machineId, socket] as const;

/** A number per client object: a machine's worker that restarts brings a client of its own. */
const clientSerials = new WeakMap<object, number>();
let lastSerial = 0;
const serialOf = (client: ClientApi) => {
  let serial = clientSerials.get(client);
  if (serial === undefined) clientSerials.set(client, (serial = ++lastSerial));
  return serial;
};

/** Each client's socket as `client:generation`, re-read whenever one of them changes. */
function useSockets(clients: readonly (ClientApi | undefined)[]): string[] {
  const subscribe = useCallback(
    (changed: () => void) => {
      const stops = clients.map((client) => client?.connectionGeneration().subscribe(changed));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    clients,
  );
  const snapshot = () =>
    clients
      .map((client) =>
        client ? `${serialOf(client)}:${client.connectionGeneration().getSnapshot() ?? ""}` : "",
      )
      .join(",");
  const joined = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => joined.split(","), [joined]);
}
/** Each machine client's pushes while a read of its list is out. */
const ledgers = new WeakMap<object, ProjectPushes<Project>>();

const combine = (results: readonly { data?: Project[] | undefined; isPending: boolean }[]) => ({
  data: results.map((result) => result.data),
  pending: results.some((result) => result.isPending),
});

/**
 * Every machine in the pool's projects, this window's own first: online ones as they read now,
 * offline ones as last seen (`online: false`, never selectable). A machine never read and now
 * offline has no list. `loaded` is false while an online machine's first read is out.
 */
export function usePoolProjects(): { lists: MachineProjectList[]; loaded: boolean } {
  const machines = useMachines();
  const { storage } = useLayout();
  const clock = useClock();
  const queryClient = useQueryClient();
  const online = machines.filter((machine) => machine.status === "online" && machine.client);
  const onlineClients = useMemo(
    () => online.map((machine) => machine.client),
    // `online` is derived from `machines`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [machines],
  );
  const sockets = useSockets(onlineClients);
  const results = useQueries({
    queries: online.map((machine, index) => ({
      queryKey: poolKey(machine.id, sockets[index] ?? ""),
      staleTime: 30_000,
      // The last socket's list stays shown while the new socket's read is out.
      placeholderData: keepPreviousData,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const client = machine.client;
        if (!client) throw new Error("offline");
        // A push that lands while the pages are out wins over them.
        const projects = await pushesFor(ledgers, client).track(() => readProjects(client, signal));
        rememberMachineProjects(storage, machine.id, projects, clock());
        return projects;
      },
    })),
    // The same object while no machine's list changed, so the lists below are kept too.
    combine,
  });
  // Each online machine's pushes: a project added, renamed, linked or removed there. One that
  // carries the project is put in place, kept on this device and kept for any read out now, so
  // a daemon reading its checkouts' remotes (ADR 0189), one push per project, never restarts a
  // read and an older read never undoes a push.
  const clients = online.map(
    (machine, index) => [machine.id, machine.client, sockets[index] ?? ""] as const,
  );
  const clientKey = clients.map(([id, , socket]) => `${id}:${socket}`).join("\n");
  useEffect(() => {
    const stops = clients.map(([id, client, socket]) =>
      client?.projects.onChanged((change) => {
        const push = pushOf<Project>(change, (workspace) => workspace);
        if (!push) {
          void queryClient.invalidateQueries({ queryKey: poolKey(id, socket), exact: true });
          return;
        }
        pushesFor(ledgers, client).record(push);
        const held = queryClient.getQueryData<Project[]>(poolKey(id, socket));
        const next = rememberMachinePush(storage, id, push, clock(), held);
        if (held && next) queryClient.setQueryData<Project[]>(poolKey(id, socket), next);
      }),
    );
    return () => {
      for (const stop of stops) stop?.();
    };
    // The clients change only with the machines' set and status.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [clientKey, queryClient, storage, clock]);
  const { data, pending } = results;
  return useMemo(() => {
    const lists = machines.flatMap((machine: Machine): MachineProjectList[] => {
      const index = online.indexOf(machine);
      const read = index < 0 ? undefined : data[index];
      const projects = read ?? keptMachineProjects(storage, machine.id)?.projects;
      if (!projects) return [];
      return [
        {
          machineId: machine.id,
          machineName: machine.name,
          online: index >= 0 && read !== undefined,
          here: machine.primary,
          projects,
        },
      ];
    });
    return { lists, loaded: !pending };
    // `online` is derived from `machines`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, storage, pending, data]);
}
