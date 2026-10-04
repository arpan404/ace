import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReviewDraft } from "./changes/drafts.ts";
import type { ClearedLines } from "./logs/cleared.ts";
import type { PreviewSource } from "./sources.ts";
import { LocalStore } from "./store.ts";
import { onTerminalEnd } from "./terminal/closing.ts";
import type { TerminalSessions } from "./terminal/sessions.ts";
import { createTabUi, type TabUiState } from "./terminal/tab-ui.ts";

export interface DiffPrefs {
  mode: "unified" | "split";
  wrap: boolean;
}

/** Everything the panels need beyond the live thread store, one instance per daemon client. */
export interface PanelServices {
  terminals: TerminalSessions;
  preview: PreviewSource;
  drafts: LocalStore<readonly ReviewDraft[]>;
  diffPrefs: LocalStore<DiffPrefs>;
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

/** The panel services bound to a client, created once and reused across threads and tabs. */
export function panelServices(client: ClientApi): Promise<PanelServices> {
  let services = byClient.get(client);
  if (!services) {
    services = load(client).then((sources) => {
      const value: PanelServices = {
        ...sources,
        drafts: new LocalStore<readonly ReviewDraft[]>([]),
        diffPrefs: new LocalStore<DiffPrefs>({ mode: "unified", wrap: false }),
        logCleared: new LocalStore<ClearedLines>(new Map()),
        terminalUi: createTabUi(),
      };
      // A closed terminal tab ends its shell (thread-kinds' onClose has no client to ask).
      onTerminalEnd((end) => sources.terminals.end(end.threadId, end.terminalId));
      ready.set(client, value);
      return value;
    });
    byClient.set(client, services);
  }
  return services;
}

/** The services once loaded (undefined for the first render after start-up). */
export function useLoadedServices(): PanelServices | undefined {
  const client = useClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      let live = true;
      void panelServices(client).then(() => {
        if (live) changed();
      });
      return () => {
        live = false;
      };
    },
    [client],
  );
  const read = useCallback(() => ready.get(client), [client]);
  return useSyncExternalStore(subscribe, read, read);
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
