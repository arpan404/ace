import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/** One page the thread's browser showed, as the person saw it. */
export interface Visit {
  url: string;
  title: string;
  /** When it was shown (ms since the epoch). */
  at: number;
}

const VisitSchema = z.object({ url: z.string(), title: z.string(), at: z.number() });
const Persisted = z.array(z.tuple([z.string(), z.array(VisitSchema)]));

const key = "ace.browser.history";
const perThread = 300;
const threads = 48;
const none: readonly Visit[] = [];

/**
 * Each thread's browsing history on this device, newest first: every page its browser showed
 * the person, for History in the browser's menu. Bounded per thread and in threads. Without
 * storage it lasts as long as the object.
 */
export class BrowsingHistory {
  private storage: KeyValueStorage | undefined;
  private entries: Map<string, readonly Visit[]>;
  private listeners = new Set<() => void>();
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    this.entries = new Map(readJson(storage, key, Persisted, []));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  visits(threadId: string): readonly Visit[] {
    return this.entries.get(threadId) ?? none;
  }
  /**
   * The page shown now. The same address as the newest visit only updates its title (a page
   * names itself after it loads); anything else is a new visit.
   */
  record(threadId: string, page: { url: string; title: string }, at: number): void {
    if (!/^https?:\/\//i.test(page.url)) return;
    const current = this.visits(threadId);
    const newest = current[0];
    if (newest?.url === page.url) {
      if (!page.title || newest.title === page.title) return;
      this.put(threadId, [{ ...newest, title: page.title }, ...current.slice(1)]);
      return;
    }
    this.put(threadId, [{ url: page.url, title: page.title, at }, ...current].slice(0, perThread));
  }
  remove(threadId: string, visit: Visit): void {
    this.put(
      threadId,
      this.visits(threadId).filter((each) => each.at !== visit.at || each.url !== visit.url),
    );
  }
  clear(threadId: string): void {
    this.entries.delete(threadId);
    this.save();
  }
  private put(threadId: string, visits: readonly Visit[]): void {
    this.entries.delete(threadId);
    this.entries.set(threadId, visits);
    // The most recently used threads are kept; the map keeps insertion order.
    while (this.entries.size > threads) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.save();
  }
  private save(): void {
    writeJson(this.storage, key, [...this.entries]);
    for (const listener of this.listeners) listener();
  }
}

/** Visits whose title or address contains every word of `query`, newest first. */
export function searchVisits(visits: readonly Visit[], query: string): readonly Visit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return visits;
  return visits.filter((visit) => {
    const text = `${visit.title} ${visit.url}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
