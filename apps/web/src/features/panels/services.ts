import type { Client } from "@ace/client";
import { useClient } from "@ace/client-react";
import { use } from "react";
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
  /** Per thread: hide log lines at or before this time (the Clear button). */
  logCutoffs: LocalStore<ReadonlyMap<string, number>>;
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

const byClient = new WeakMap<Client, Promise<PanelServices>>();

/** The panel services bound to a client, created once and reused across threads and tabs. */
export function panelServices(client: Client): Promise<PanelServices> {
  let services = byClient.get(client);
  if (!services) {
    services = load().then((sources) => ({
      ...sources,
      drafts: new LocalStore<readonly ReviewDraft[]>([]),
      diffPrefs: new LocalStore<DiffPrefs>({ mode: "unified", wrap: false }),
      logCutoffs: new LocalStore<ReadonlyMap<string, number>>(new Map()),
    }));
    byClient.set(client, services);
  }
  return services;
}

/** Suspends until the services are ready; render under a Suspense boundary. */
export function usePanelServices(): PanelServices {
  return use(panelServices(useClient()));
}
