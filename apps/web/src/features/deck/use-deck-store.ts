import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ConductorCommandPayload } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import type { DeckSnapshot, DeckStore } from "./deck-store.ts";

const empty: DeckSnapshot = { ready: false, entries: [], seen: new Map(), error: undefined };

/**
 * The deck store, loaded after first paint: the rail counts Deck escalations on every screen,
 * but the store and its protocol code aren't needed to draw the first one.
 */
export class LazyDeckStore {
  private client: ClientApi;
  private store: DeckStore | undefined;
  private loading: Promise<DeckStore> | undefined;
  private listeners = new Set<() => void>();
  constructor(client: ClientApi) {
    this.client = client;
  }
  private load(): Promise<DeckStore> {
    this.loading ??= import("./deck-store.ts").then(({ DeckStore }) => {
      const store = new DeckStore(this.client, {
        now: () => Date.now(),
        id: () => crypto.randomUUID(),
      });
      this.store = store;
      store.subscribe(() => {
        for (const listener of this.listeners) listener();
      });
      for (const listener of this.listeners) listener();
      return store;
    });
    return this.loading;
  }
  snapshot = (): DeckSnapshot => this.store?.snapshot() ?? empty;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    void this.load();
    return () => this.listeners.delete(listener);
  };
  async send(payload: ConductorCommandPayload): Promise<void> {
    await (await this.load()).send(payload);
  }
  ensure(runId: string): void {
    void this.load().then((store) => store.ensure(runId));
  }
}

const stores = new WeakMap<ClientApi, LazyDeckStore>();

/** One store per daemon client, so each connection (and each test) reads its own daemon. */
export function useDeckStore(): LazyDeckStore {
  const client = useClient();
  let store = stores.get(client);
  if (!store) {
    store = new LazyDeckStore(client);
    stores.set(client, store);
  }
  return store;
}

export function useDeckSnapshot(): DeckSnapshot {
  const store = useDeckStore();
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** Send a `conductor.*` command; rejects with a readable reason when the daemon refuses. */
export function useDeckSender(): (payload: ConductorCommandPayload) => Promise<void> {
  const store = useDeckStore();
  return (payload) => store.send(payload);
}
