import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReviewDraft } from "./changes/drafts.ts";
import { unavailablePreview, unavailableTerminals, type PreviewSource } from "./sources.ts";
import { LocalStore } from "./store.ts";
import { TerminalSessions } from "./terminal/sessions.ts";

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
  logCleared: LocalStore<ReadonlyMap<string, ReadonlySet<string>>>;
}

async function load(): Promise<Pick<PanelServices, "terminals" | "preview">> {
  // The fake services ship only in `vite --mode fake` and tests; Vite drops this branch from
  // production builds the same way main.tsx drops the fake daemon.
  if (import.meta.env.MODE === "fake" || import.meta.env.MODE === "test") {
    const fake = (await import("@ace/fake-daemon")).panelServices();
    return { terminals: new TerminalSessions(fake.terminals), preview: fake.browser };
  }
  return { terminals: new TerminalSessions(unavailableTerminals), preview: unavailablePreview };
}

const byClient = new WeakMap<ClientApi, Promise<PanelServices>>();
const ready = new WeakMap<ClientApi, PanelServices>();

/** The panel services bound to a client, created once and reused across threads and tabs. */
export function panelServices(client: ClientApi): Promise<PanelServices> {
  let services = byClient.get(client);
  if (!services) {
    services = load().then((sources) => {
      const value: PanelServices = {
        ...sources,
        drafts: new LocalStore<readonly ReviewDraft[]>([]),
        diffPrefs: new LocalStore<DiffPrefs>({ mode: "unified", wrap: false }),
        logCleared: new LocalStore<ReadonlyMap<string, ReadonlySet<string>>>(new Map()),
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
