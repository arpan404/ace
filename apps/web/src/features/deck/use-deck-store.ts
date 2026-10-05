import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ConductorCommandPayload } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import type { DeckSnapshot, DeckStore } from "./deck-store.ts";

const empty: DeckSnapshot = {
  ready: false,
  entries: [],
  error: undefined,
  more: false,
  missing: new Set(),
};

/**
 * The deck store, loaded after first paint: the sidebar counts Deck decisions on every screen,
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
  /** The store's own subscription, held while anything here listens. */
  private inner: (() => void) | undefined;
  private notify = () => {
    for (const listener of this.listeners) listener();
  };
  private load(): Promise<DeckStore> {
    this.loading ??= import("./deck-store.ts").then(({ DeckStore }) => {
      const store = new DeckStore(this.client, { id: () => crypto.randomUUID() });
      this.store = store;
      this.attach();
      this.notify();
      return store;
    });
    return this.loading;
  }
  private attach(): void {
    if (this.store && this.listeners.size && !this.inner)
      this.inner = this.store.subscribe(this.notify);
  }
  snapshot = (): DeckSnapshot => this.store?.snapshot() ?? empty;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.attach();
    void this.load();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      // Nothing on screen reads decks: the store stops its timed reads (its watches stay).
      this.inner?.();
      this.inner = undefined;
    };
  };
  async send(payload: ConductorCommandPayload): Promise<void> {
    await (await this.load()).send(payload);
  }
  retry(): void {
    void this.load().then((store) => store.retry());
  }
  more(): void {
    void this.load().then((store) => store.more());
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

/** Read the deck list again after it failed. */
export function useDeckRetry(): () => void {
  const store = useDeckStore();
  return () => store.retry();
}

/** Read the next page of older decks. */
export function useDeckMore(): () => void {
  const store = useDeckStore();
  return () => store.more();
}

/** Send a `conductor.*` command; rejects with a readable reason when the daemon refuses. */
export function useDeckSender(): (payload: ConductorCommandPayload) => Promise<void> {
  const store = useDeckStore();
  return (payload) => store.send(payload);
}
