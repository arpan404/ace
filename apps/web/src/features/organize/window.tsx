import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { ThreadId, type ThreadListEntry } from "@ace/protocol";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { createContext, use, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { machineRow } from "@/lib/machine-threads.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { pendingActionsOf, type PendingAction } from "@/lib/pending-actions.ts";
import {
  ArchiveConfirmationProvider,
  DeleteConfirmationProvider,
  useArchiveConfirmation,
  useDeleteConfirmation,
} from "./delete-confirmation.ts";
import { ThreadMoverProvider, type MoveRequest } from "./mover.ts";
import { overlayOf } from "./overlay.ts";
import { routedThreadActions } from "./routed-actions.ts";
import { HomeSelectionProvider } from "./selection.ts";
import { threadActionsOn, type ThreadActions } from "./use-thread-actions.ts";

/** This window's own daemon's client, readable from inside another machine's scope too. */
const WindowClient = createContext<ClientApi | undefined>(undefined);

/**
 * What organizing shares across one window (ADR 0100): the Home selection, the project picker
 * and the delete and archive questions, so a menu in another machine's row or thread reaches the
 * one dialog the shell hosts; and this window's own client. Mounted under the window's client.
 */
export function OrganizeWindow(props: { children: ReactNode }) {
  const client = useClient();
  return (
    <WindowClient value={client}>
      <HomeSelectionProvider>
        <ThreadMoverProvider>
          <DeleteConfirmationProvider>
            <ArchiveConfirmationProvider>{props.children}</ArchiveConfirmationProvider>
          </DeleteConfirmationProvider>
        </ThreadMoverProvider>
      </HomeSelectionProvider>
    </WindowClient>
  );
}

/** The Home list's rows as organize targets, whichever machine each is on. */
export interface WindowThreads {
  /** Actions taking list row ids, each run on the row's own machine. */
  actions: ThreadActions;
  /** A row's thread as this window shows it (pending actions applied), under its row id. */
  entry(rowId: string): ThreadListEntry | undefined;
  /** The machine a row is on, when it isn't this window's own. */
  hostOf(rowId: string): string | undefined;
}

/**
 * Organize actions and entries over the Home list's row ids: this window's threads through its
 * own client, another machine's (`machine:[hostId,threadId]`) through that machine's, while it
 * is online. Works the same inside a `MachineScope`, so a bulk menu in another machine's row
 * still acts on every picked row.
 */
export function useWindowThreads(): WindowThreads {
  const scoped = useClient();
  const own = use(WindowClient) ?? scoped;
  const machines = useMachines();
  const pool = useMachinePool();
  const confirmation = useDeleteConfirmation();
  const archiving = useArchiveConfirmation();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  return useMemo(() => {
    const make = (client: ClientApi, machine: { machine?: string }) =>
      threadActionsOn({
        overlay: overlayOf(client),
        confirmation,
        archiving,
        client,
        toast,
        navigate,
        router,
        machine,
      });
    const mine = make(own, {});
    const others = new Map<string, { machine: Machine; actions: ThreadActions }>();
    for (const machine of machines)
      if (!machine.primary && machine.client)
        others.set(machine.id, {
          machine,
          actions: make(machine.client, { machine: machine.id }),
        });
    const actions = routedThreadActions((rowId) => {
      const row = machineRow(rowId);
      if (!row) return { actions: mine, threadId: rowId };
      const other = others.get(row.hostId);
      return other && { actions: other.actions, threadId: row.threadId };
    });
    const entry = (rowId: string): ThreadListEntry | undefined => {
      const row = machineRow(rowId);
      if (!row) {
        const lease = own.threads();
        const found = lease.store.thread(rowId);
        lease.release();
        return found && overlayOf(own).apply(found);
      }
      const found = pool?.threads.thread(row.key)?.thread;
      if (!found) return undefined;
      const client = others.get(row.hostId)?.machine.client;
      const shown = client ? overlayOf(client).apply(found) : found;
      return { ...shown, id: ThreadId.parse(rowId) };
    };
    return { actions, entry, hostOf: (rowId) => machineRow(rowId)?.hostId };
  }, [own, machines, pool, confirmation, archiving, toast, navigate, router]);
}

/**
 * The project picker's request for list rows, on the machine they are all on; undefined while
 * they are on more than one, since a project belongs to one machine. The picker runs on that
 * machine, so it gets the ids that machine knows.
 */
export function moveRequestOf(
  entries: readonly ThreadListEntry[],
  threads: WindowThreads,
): MoveRequest | undefined {
  const hosts = new Set(entries.map((entry) => threads.hostOf(entry.id)));
  if (hosts.size !== 1) return undefined;
  const [hostId] = hosts;
  return {
    entries: entries.map((entry) => ({ ...entry, id: machineRow(entry.id)?.threadId ?? entry.id })),
    ...(hostId ? { hostId } : {}),
  };
}

const noPending: readonly (readonly PendingAction[])[] = [];

/**
 * Other machines' list entries (under their row ids) with their pending organize actions applied,
 * so a pin or archive on another machine's row shows at once, as it does on this window's own.
 */
export function useOverlaidMachineEntries(
  entries: readonly ThreadListEntry[],
): readonly ThreadListEntry[] {
  const machines = useMachines();
  const clients = useMemo(
    () =>
      new Map(
        machines.flatMap((machine) =>
          !machine.primary && machine.client ? [[machine.id, machine.client] as const] : [],
        ),
      ),
    [machines],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = [...clients.values()].map((client) =>
        pendingActionsOf(client).subscribe(listener),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    [clients],
  );
  // The same array while no machine's pending list changed, as the store's snapshot must be.
  const last = useRef(noPending);
  const read = () => {
    const next = [...clients.values()].map((client) => pendingActionsOf(client).all());
    const same =
      next.length === last.current.length &&
      next.every((list, index) => list === last.current[index]);
    if (!same) last.current = next;
    return last.current;
  };
  const pending = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    if (!pending.some((list) => list.length)) return entries;
    return entries.map((entry) => {
      const row = machineRow(entry.id);
      const client = row && clients.get(row.hostId);
      if (!row || !client) return entry;
      const shown = overlayOf(client).apply({ ...entry, id: ThreadId.parse(row.threadId) });
      return { ...shown, id: entry.id };
    });
  }, [entries, clients, pending]);
}
