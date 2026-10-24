import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { createContext, createElement, use, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

/** What "Continue on…" or "Open on…" carries to another machine. */
export type TransferRequest = (
  | { kind: "thread"; threadId: string; workspaceId: string; title: string }
  | { kind: "project"; workspaceId: string; name: string }
) & {
  /**
   * The machine the work is on, when it isn't this window's own (a thread opened with
   * `?machine=`): the chooser then runs against that machine's client (ADR 0100).
   */
  hostId?: string | undefined;
  /** Open straight on the options step for this machine (Try again without known options). */
  machine?: { hostId: string; name: string } | undefined;
};

interface State {
  request: TransferRequest | undefined;
  /** False while the chooser plays its exit, with the request kept for it. */
  open: boolean;
  /** Counts openings, so each one starts the chooser over. */
  opening: number;
}

/**
 * "Continue on…" from a thread menu and "Open on…" from a project menu: one machine chooser per
 * window, so every menu opens the same one (ADR 0099), including menus in another machine's
 * thread, whose client differs from the window's.
 */
export class TransferOpener {
  private state: State = { request: undefined, open: false, opening: 0 };
  private listeners = new Set<() => void>();
  getState = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  open(request: TransferRequest): void {
    this.set({ request, open: true, opening: this.state.opening + 1 });
  }
  close(): void {
    if (this.state.open) this.set({ ...this.state, open: false });
  }
  private set(state: State): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

const WindowOpener = createContext<TransferOpener | undefined>(undefined);

/** The window's chooser, for every view below, whichever machine's client they run against. */
export function TransferOpenerProvider(props: { children: ReactNode }) {
  const [opener] = useState(() => new TransferOpener());
  return createElement(WindowOpener, { value: opener }, props.children);
}

/** Outside a provider (a view rendered on its own), one chooser per client. */
const byClient = new WeakMap<ClientApi, TransferOpener>();

export function useTransferOpener(): TransferOpener {
  const window = use(WindowOpener);
  const client = useClient();
  return useMemo(() => {
    if (window) return window;
    let opener = byClient.get(client);
    if (!opener) {
      opener = new TransferOpener();
      byClient.set(client, opener);
    }
    return opener;
  }, [window, client]);
}

export function useTransferRequest(): State {
  const opener = useTransferOpener();
  return useSyncExternalStore(opener.subscribe, opener.getState, opener.getState);
}
