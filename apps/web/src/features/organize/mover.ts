import { useSyncExternalStore } from "react";
import { perWindow } from "@/lib/per-window.ts";
import type { ThreadTarget } from "./use-thread-actions.ts";

/** Threads waiting for the person to pick the project they move to. */
export interface MoveRequest {
  entries: readonly ThreadTarget[];
  /**
   * The machine the threads are on, when it isn't this window's own (ADR 0100): the picker then
   * lists that machine's projects and moves them there. A thread never moves between machines.
   */
  hostId?: string | undefined;
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
 * window, so every surface opens the same one, another machine's thread too (`perWindow`).
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

const movers = perWindow(() => new ThreadMover());
export const ThreadMoverProvider = movers.Provider;
export const useThreadMover = movers.use;

/** The move waiting on a project, and whether its picker shows. */
export function useMoveState(): State {
  const mover = useThreadMover();
  return useSyncExternalStore(mover.subscribe, mover.getState, mover.getState);
}
