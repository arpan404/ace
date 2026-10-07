import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useMemo, useSyncExternalStore } from "react";
import type { ThreadTarget } from "./use-thread-actions.ts";

/** Threads waiting for the person to pick the project they move to. */
export interface MoveRequest {
  entries: readonly ThreadTarget[];
  /** After the move is sent (a bulk move clears the selection then). */
  onMoved?(): void;
}

interface State {
  request: MoveRequest | undefined;
  /** False while the picker plays its exit, with the request kept for it. */
  open: boolean;
}

/**
 * "Move to project…" from any thread menu, the selection bar or the palette: one picker per
 * window (keyed by its client, like the organize overlay), so every surface opens the same one.
 */
export class ThreadMover {
  private state: State = { request: undefined, open: false };
  private listeners = new Set<() => void>();
  getState = (): State => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Ask where these threads go. */
  open(request: MoveRequest): void {
    if (request.entries.length) this.set({ request, open: true });
  }
  close(): void {
    if (this.state.open) this.set({ ...this.state, open: false });
  }
  private set(state: State): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

const movers = new WeakMap<ClientApi, ThreadMover>();

export function useThreadMover(): ThreadMover {
  const client = useClient();
  return useMemo(() => {
    let mover = movers.get(client);
    if (!mover) {
      mover = new ThreadMover();
      movers.set(client, mover);
    }
    return mover;
  }, [client]);
}

/** The move waiting on a project, and whether its picker shows. */
export function useMoveState(): State {
  const mover = useThreadMover();
  return useSyncExternalStore(mover.subscribe, mover.getState, mover.getState);
}
