import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useMemo, useSyncExternalStore } from "react";

/** What "Continue on…" or "Open on…" carries to another machine. */
export type TransferRequest =
  | { kind: "thread"; threadId: string; workspaceId: string; title: string }
  | { kind: "project"; workspaceId: string; name: string };

interface State {
  request: TransferRequest | undefined;
  /** False while the chooser plays its exit, with the request kept for it. */
  open: boolean;
  /** Counts openings, so each one starts the chooser over. */
  opening: number;
}

/**
 * "Continue on…" from a thread menu and "Open on…" from a project menu: one machine chooser per
 * window (keyed by its client), so every menu opens the same one (ADR 0099).
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

const openers = new WeakMap<ClientApi, TransferOpener>();

export function useTransferOpener(): TransferOpener {
  const client = useClient();
  return useMemo(() => {
    let opener = openers.get(client);
    if (!opener) {
      opener = new TransferOpener();
      openers.set(client, opener);
    }
    return opener;
  }, [client]);
}

export function useTransferRequest(): State {
  const opener = useTransferOpener();
  return useSyncExternalStore(opener.subscribe, opener.getState, opener.getState);
}
