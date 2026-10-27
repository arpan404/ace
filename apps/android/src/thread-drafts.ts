import { z } from "zod";

/**
 * Unsent composer words per thread, kept on this phone across navigation and
 * relaunch. iOS parity (`ThreadDrafts`): 50 drafts with the oldest falling off,
 * each up to 100,000 characters. Only words are kept; the SQLite outbox owns
 * pending sends, staged attachments have their own lifetime.
 *
 * Durability limits: the backing is async (SQLite), so `save` updates the
 * readable cache synchronously and orders disk writes behind it. Navigation and
 * `flush`/`settled` close the gap to milliseconds, but Android can still kill
 * the process before a pending write commits: a kill inside that window loses
 * the last edit, unlike iOS's synchronous file write. Treat drafts as
 * best-effort across kills, exact across navigation and relaunch.
 */
export const threadDraftLimit = 50;
export const threadDraftCharacters = 100_000;

/** Least recently written first. */
export type ThreadDraftEntries = readonly (readonly [key: string, text: string])[];

/** One machine's thread: thread ids are only unique per machine. */
export function draftKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

const StoredEntries = z.array(z.tuple([z.string(), z.string()]));

/** Corrupt or missing storage reads as no drafts; the next save repairs it. */
export function parseDraftEntries(json: string | null): ThreadDraftEntries {
  if (json === null) return [];
  try {
    return StoredEntries.parse(JSON.parse(json) as unknown);
  } catch {
    return [];
  }
}

export function serializeDraftEntries(entries: ThreadDraftEntries): string {
  return JSON.stringify(entries);
}

/**
 * Truncate to the per-draft limit by Unicode code point, never by UTF-16 code
 * unit: `String.slice` can split a surrogate pair (emoji, many CJK extensions)
 * and leave a lone surrogate behind. Code points keep every pair whole; a
 * trailing combining mark or ZWJ sequence may still part, which only costs a
 * glyph, never a corrupt string.
 */
export function truncateDraftText(text: string): string {
  if (text.length <= threadDraftCharacters) return text;
  return Array.from(text).slice(0, threadDraftCharacters).join("");
}

/**
 * Keep `text` as the newest draft; words that are only whitespace remove it.
 * Pure so the eviction/truncation rules stay testable without storage.
 */
export function applyDraftSave(
  entries: ThreadDraftEntries,
  key: string,
  text: string,
): ThreadDraftEntries {
  const rest = entries.filter(([candidate]) => candidate !== key);
  if (text.trim().length === 0) return rest;
  const next: ThreadDraftEntries = [...rest, [key, truncateDraftText(text)] as const];
  return next.slice(-threadDraftLimit);
}

function sameEntries(a: ThreadDraftEntries, b: ThreadDraftEntries): boolean {
  return (
    a.length === b.length &&
    a.every(([key, text], index) => b[index]?.[0] === key && b[index]?.[1] === text)
  );
}

export interface ThreadDraftPersistence {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

/** In-memory backing: the runtime's fallback when SQLite is unavailable. */
export function memoryDraftPersistence(json: string | null = null): ThreadDraftPersistence {
  let stored = json;
  return {
    load: async () => stored,
    save: async (value: string) => {
      stored = value;
    },
  };
}

/**
 * Durable per-thread drafts behind an async backing (SQLite in production,
 * memory in tests). `save` updates the readable cache synchronously and orders
 * disk writes, so a failed write keeps the words in memory for the next attempt.
 */
export class ThreadDraftStore {
  #entries: ThreadDraftEntries = [];
  #opened = false;
  readonly #persist: ThreadDraftPersistence;
  #writes: Promise<void> = Promise.resolve();

  constructor(persist: ThreadDraftPersistence) {
    this.#persist = persist;
  }

  /**
   * Read stored drafts before the UI shows them. Never throws: like iOS
   * (`file.load() ?? []`), a failed or corrupt load reads as no drafts and the
   * next save repairs storage. A throwing `open` would take down the whole
   * runtime, so drafts must not be load-bearing.
   */
  async open(): Promise<void> {
    if (this.#opened) return;
    try {
      this.#entries = parseDraftEntries(await this.#persist.load());
    } catch {
      this.#entries = [];
    }
    this.#opened = true;
  }

  textFor(key: string): string {
    return this.#entries.find(([candidate]) => candidate === key)?.[1] ?? "";
  }

  /** Settles when every ordered disk write so far has finished. */
  settled(): Promise<void> {
    return this.#writes;
  }

  save(text: string, key: string): Promise<void> {
    const next = applyDraftSave(this.#entries, key, text);
    if (sameEntries(next, this.#entries)) return this.#writes;
    this.#entries = next;
    const json = serializeDraftEntries(next);
    this.#writes = this.#writes.then(() => this.#persist.save(json)).catch(() => {});
    return this.#writes;
  }
}
