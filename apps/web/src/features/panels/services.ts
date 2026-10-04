import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReviewDraft } from "./changes/drafts.ts";
import type { ClearedLines } from "./logs/cleared.ts";
import type { PreviewSource } from "./sources.ts";
import { LocalStore } from "./store.ts";
import type { TerminalSessions } from "./terminal/sessions.ts";

export interface DiffPrefs {
  /** `auto` is unified in a narrow dock and split where both sides fit. */
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
        diffPrefs: new LocalStore<DiffPrefs>({ mode: "auto", wrap: false, tree: true }),
        viewed: new LocalStore<ViewedFiles>(new Map()),
        logCleared: new LocalStore<ClearedLines>(new Map()),
      };
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

/** Shows a terminal the daemon started for the thread (a script run) in the Terminal tab. */
export async function revealTerminal(
  client: ClientApi,
  threadId: string,
  terminalId: string,
): Promise<void> {
  const services = await panelServices(client);
  await services.terminals.reveal(threadId, terminalId);
}

/** Shows the thread's running terminal called `name`; false when none is running. */
export async function revealRunningTerminal(
  client: ClientApi,
  threadId: string,
  name: string,
): Promise<boolean> {
  const services = await panelServices(client);
  return services.terminals.revealRunning(threadId, name);
}
