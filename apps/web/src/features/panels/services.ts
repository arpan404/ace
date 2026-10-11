import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReviewDraft } from "./changes/drafts.ts";
import type { ClearedLines } from "./logs/cleared.ts";
import type { PreviewSource } from "./sources.ts";
import { LocalStore } from "./store.ts";
import type { TerminalEnd } from "./terminal/closing.ts";
import type { TerminalSessions } from "./terminal/sessions.ts";
import type { TabUiState } from "./terminal/tab-ui.ts";

export interface DiffPrefs {
  /** `auto` is unified in a narrow panel and split where both sides fit. */
  mode: "auto" | "unified" | "split";
  wrap: boolean;
  /** The changed-files tree beside the diff. */
  tree: boolean;
}

/** Per thread, the files marked viewed, each with the version of its diff that was viewed. */
export type ViewedFiles = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Everything the panels need beyond the live thread store, one instance per daemon client. */
export interface PanelServices {
  terminals: TerminalSessions;
  preview: PreviewSource;
  drafts: LocalStore<readonly ReviewDraft[]>;
  diffPrefs: LocalStore<DiffPrefs>;
  viewed: LocalStore<ViewedFiles>;
  /**
   * Per thread: the log lines Clear hid, by key. Keys rather than a time, because backdated or
   * replayed events can arrive stamped earlier than lines already shown.
   */
  logCleared: LocalStore<ClearedLines>;
  /** Find and rename state of terminal and shell tabs, shared by their views and strip actions. */
  terminalUi: LocalStore<TabUiState>;
}

async function load(client: ClientApi): Promise<Pick<PanelServices, "terminals" | "preview">> {
  return (await import("./panel-sources.ts")).createPanelSources(client);
}

const byClient = new WeakMap<ClientApi, Promise<PanelServices>>();
const ready = new WeakMap<ClientApi, PanelServices>();
// Close intents belong to the client, including while its service chunk is unavailable.
const terminalEnds = new WeakMap<ClientApi, Map<string, TerminalEnd>>();

function drainTerminalEnds(client: ClientApi, services: PanelServices): void {
  const pending = terminalEnds.get(client);
  terminalEnds.delete(client);
  for (const end of pending?.values() ?? []) services.terminals.end(end.threadId, end.terminalId);
}

/** Retain tab-close intents until this client's terminal services are usable. */
export function endPanelTerminal(client: ClientApi, end: TerminalEnd): void {
  const pending = terminalEnds.get(client) ?? new Map<string, TerminalEnd>();
  pending.set(end.terminalId, end);
  terminalEnds.set(client, pending);
  const services = ready.get(client);
  if (services) drainTerminalEnds(client, services);
  else void panelServices(client).catch(() => {});
}

type ServiceLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; services: PanelServices };
const loading: ServiceLoad = { status: "loading" };
const states = new WeakMap<ClientApi, ServiceLoad>();
const listeners = new WeakMap<ClientApi, Set<() => void>>();
function publish(client: ClientApi, state: ServiceLoad) {
  states.set(client, state);
  for (const changed of listeners.get(client) ?? []) changed();
}

/** The panel services bound to a client, created once and reused across threads and tabs. */
export function panelServices(
  client: ClientApi,
  loadSources: typeof load = load,
): Promise<PanelServices> {
  const existing = byClient.get(client);
  if (existing) return existing;
  const services = Promise.resolve()
    .then(() => loadSources(client))
    .then(
      (sources) => {
        if (byClient.get(client) !== services) {
          sources.preview.dispose();
          throw new Error("panel_services_disposed");
        }
        const value: PanelServices = {
          ...sources,
          drafts: new LocalStore<readonly ReviewDraft[]>([]),
          diffPrefs: new LocalStore<DiffPrefs>({ mode: "auto", wrap: false, tree: true }),
          viewed: new LocalStore<ViewedFiles>(new Map()),
          logCleared: new LocalStore<ClearedLines>(new Map()),
          terminalUi: new LocalStore<TabUiState>(new Map()),
        };
        ready.set(client, value);
        drainTerminalEnds(client, value);
        publish(client, { status: "ready", services: value });
        return value;
      },
      (error: unknown) => {
        if (byClient.get(client) !== services) throw error;
        byClient.delete(client);
        publish(client, {
          status: "failed",
          message: error instanceof Error ? error.message : "Couldn't load the panels.",
        });
        throw error;
      },
    );
  byClient.set(client, services);
  publish(client, loading);
  return services;
}

/** Retire one daemon client's cached previews and ignore pending service loads. */
export function disposePanelServices(client: ClientApi): void {
  ready.get(client)?.preview.dispose();
  byClient.delete(client);
  ready.delete(client);
  terminalEnds.delete(client);
  states.delete(client);
  listeners.delete(client);
}

/** A client's services if they have loaded, without loading them. */
export function loadedPanelServices(client: ClientApi): PanelServices | undefined {
  return ready.get(client);
}

/** Shared loading, failure and readiness, including loads started outside a mounted panel. */
export function usePanelServiceLoad(): ServiceLoad {
  const client = useClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      const group = listeners.get(client) ?? new Set<() => void>();
      listeners.set(client, group);
      group.add(changed);
      if (!states.has(client)) void panelServices(client).catch(() => {});
      return () => {
        group.delete(changed);
      };
    },
    [client],
  );
  const read = useCallback(() => states.get(client) ?? loading, [client]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The services once loaded (undefined for the first render after start-up). */
export function useLoadedServices(): PanelServices | undefined {
  const state = usePanelServiceLoad();
  return state.status === "ready" ? state.services : undefined;
}

export const PanelServicesContext = createContext<PanelServices | undefined>(undefined);

/** The services, inside a panel tab (thread-panels.tsx provides them once loaded). */
export function usePanelServices(): PanelServices {
  const services = useContext(PanelServicesContext);
  if (!services) throw new Error("usePanelServices needs the thread panels' services provider");
  return services;
}

/**
 * The thread's terminal called `name` if it is still running (a script started again goes back
 * to its terminal rather than a second copy).
 */
export async function findRunningTerminal(
  client: ClientApi,
  threadId: string,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const services = await panelServices(client);
  return services.terminals.findRunning(threadId, name);
}

const noNames: ReadonlySet<string> = new Set();

/**
 * Names of the thread's terminals still running, as the daemon last listed them: a script
 * whose terminal runs reads "running" in the Run menu. Empty until the panel services load (the
 * first call loads them and reads the thread's terminals).
 */
export function useRunningTerminalNames(threadId: string): ReadonlySet<string> {
  const services = useLoadedServices();
  const source = services?.terminals.source;
  const subscribe = useCallback(
    (changed: () => void) => (source ? source.subscribe(changed) : () => {}),
    [source],
  );
  const version = useSyncExternalStore(subscribe, () => source?.version ?? -1);
  return useMemo(
    () =>
      source && version >= 0
        ? new Set(
            source
              .list(threadId)
              .filter((terminal) => !terminal.exited)
              .map((terminal) => terminal.name),
          )
        : noNames,
    [source, threadId, version],
  );
}
