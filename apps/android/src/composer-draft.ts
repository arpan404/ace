import type { Selection } from "@ace/client";

/** Durable per-thread words. Null keeps the draft only while it is on screen. */
export interface DraftStore {
  textFor(key: string): string;
  save(text: string, key: string): void | Promise<void>;
}

export interface DraftValue {
  readonly text: string;
  readonly saving: boolean;
}
/** UI-owned editing state. The injected submit port owns persistence and command correctness. */
export class ComposerDraft {
  #value: DraftValue = { text: "", saving: false };
  #revision = 0;
  #listeners = new Set<() => void>();
  #submit: (text: string) => Promise<unknown>;
  #store: DraftStore | null = null;
  #key: string | null = null;
  #pendingSave: ReturnType<typeof setTimeout> | undefined;
  readonly #saveDelayMs: number;
  readonly selection: Selection<DraftValue> = {
    getSnapshot: () => this.#value,
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };
  constructor(submit: (text: string) => Promise<unknown>, options?: { saveDelayMs?: number }) {
    this.#submit = submit;
    this.#saveDelayMs = options?.saveDelayMs ?? 300;
  }
  /**
   * Follow `key`'s saved words in `store`: the composer shows them and keeps
   * them as they change. The draft it followed before is saved first.
   */
  follow(key: string | null, store: DraftStore | null): void {
    if (key === this.#key && store === this.#store) return;
    this.flush();
    this.#store = store;
    this.#key = key;
    const restored = key === null ? "" : (store?.textFor(key) ?? "");
    this.#publish({ text: restored, saving: this.#value.saving });
  }
  /** Save what is typed now, without waiting for typing to pause. */
  flush(): void {
    if (this.#pendingSave !== undefined) {
      clearTimeout(this.#pendingSave);
      this.#pendingSave = undefined;
    }
    void this.#persistNow();
  }
  /**
   * `flush` the caller can await: backgrounding gives the disk write its best
   * chance before the process goes. Awaiting does not guarantee durability —
   * the OS may still kill the app mid-write, and a kill with no flush at all
   * (crash, force-stop) loses edits since the last pause. Navigation switches
   * threads through `follow`, which flushes synchronously into the store's
   * in-memory cache, so only a kill in the same instant loses words.
   */
  flushAsync(): Promise<void> {
    if (this.#pendingSave !== undefined) {
      clearTimeout(this.#pendingSave);
      this.#pendingSave = undefined;
    }
    return this.#persistNow();
  }
  edit(text: string): void {
    this.#revision++;
    this.#publish({ text, saving: this.#value.saving });
    this.#scheduleSave();
  }
  async send(): Promise<"saved" | "empty"> {
    if (!this.#value.text.trim() || this.#value.saving) return "empty";
    const revision = this.#revision,
      submitted = this.#value.text;
    this.#publish({ text: submitted, saving: true });
    try {
      await this.#submit(submitted);
      if (this.#revision === revision) {
        this.#publish({ text: "", saving: false });
        // A sent message leaves no draft: the emptied composer saves at once,
        // so a relaunch never offers words that already went. No flush needed.
        this.#cancelPending();
        this.#persistNow();
      } else {
        this.#publish({ text: this.#value.text, saving: false });
        this.#scheduleSave();
      }
      return "saved";
    } catch (error) {
      this.#publish({ text: this.#value.text, saving: false });
      // A refused send keeps its draft durably, even if typing never paused.
      this.flush();
      throw error;
    }
  }
  /**
   * Typing saves once it pauses; an emptied composer (a sent message) saves at
   * once, so a relaunch never offers words that already went.
   */
  #scheduleSave(): void {
    if (this.#store === null || this.#key === null) return;
    if (this.#value.text.trim().length === 0) {
      this.#cancelPending();
      this.#persistNow();
      return;
    }
    this.#cancelPending();
    this.#pendingSave = setTimeout(() => {
      this.#pendingSave = undefined;
      this.#persistNow();
    }, this.#saveDelayMs);
  }
  #cancelPending(): void {
    if (this.#pendingSave !== undefined) {
      clearTimeout(this.#pendingSave);
      this.#pendingSave = undefined;
    }
  }
  /** A failed draft write keeps the words on screen for the next attempt. */
  #persistNow(): Promise<void> {
    if (this.#store === null || this.#key === null) return Promise.resolve();
    try {
      const written = this.#store.save(this.#value.text, this.#key);
      if (written instanceof Promise) return written.catch(() => {});
      return Promise.resolve();
    } catch {
      // Keep the words on screen; the next edit or flush retries.
      return Promise.resolve();
    }
  }
  #publish(value: DraftValue) {
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }
}
