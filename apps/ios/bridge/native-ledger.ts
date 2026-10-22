/*
 * What native holds of a thread it keeps between visits: for each kept key, the patch it last
 * confirmed (without its navigation generation). Reopening a kept thread sends only the patches
 * that differ, and removes what native holds that the thread no longer has, so a thread you just
 * left paints at once and its reopening costs a few frames instead of the whole transcript.
 *
 * A key is kept only when native's state for it is exactly its last patch. Item and block rows
 * also carry their position, which `position:`/`blockPosition:` patches move on their own, so
 * delivering one of those forgets the row it moved. Lanes, steps, models and attachments belong
 * to one visit and are never kept.
 */

const kept =
  /^thread:(item|interaction|block):|^thread:(metadata|cursor|controls|history|queue|pill|tune)$/;
const removable = /^thread:(item|interaction|block):/;
const moves: Record<string, string> = {
  "thread:position:": "thread:item:",
  "thread:blockPosition:": "thread:block:",
};

export function keptKey(key: string): boolean {
  return kept.test(key);
}

/** A patch's content apart from the navigation generation it was sent for. */
export function ledgerText(patch: Record<string, unknown>): string {
  const { epoch: _epoch, ...content } = patch;
  return JSON.stringify(content);
}

export class NativeLedger {
  readonly threadId: string;
  #entries = new Map<string, string>();
  #streaming = new Map<string, string>();
  #bytes = 0;
  /** Native holds this ledger's patches: an "all" pass diffs instead of resetting. */
  #held = false;
  #pass: Set<string> | undefined;

  constructor(threadId: string) {
    this.threadId = threadId;
  }
  get bytes(): number {
    return this.#bytes;
  }
  get held(): boolean {
    return this.#held;
  }
  /** Native confirmed it holds this ledger's patches (a warm reopen) or cleared its copy. */
  hold(): void {
    this.#held = true;
  }
  /** Whether native already shows exactly this patch for `key`. */
  same(key: string, text: string): boolean {
    return this.#entries.get(key) === text;
  }
  /**
   * The row text native last confirmed for an item still streaming, kept apart from the entry so
   * each delta reads it without parsing the row (`text-edit.ts`).
   */
  streaming(key: string): string | undefined {
    return this.#entries.has(key) ? this.#streaming.get(key) : undefined;
  }
  /** Native's copy of `key` is no longer known, after it turned a frame down. */
  forget(key: string): void {
    this.#forget(key);
  }
  /** Native confirmed delivery of `text` for `key` (a row of null removes what it held). */
  delivered(key: string, patch: Record<string, unknown>, text: string): void {
    if (key === "thread:reset") {
      this.clear();
      this.#held = true;
      return;
    }
    for (const [prefix, row] of Object.entries(moves))
      if (key.startsWith(prefix)) this.#forget(row + key.slice(prefix.length));
    if (!keptKey(key)) return;
    if (removable.test(key) && patch.row === null) this.#forget(key);
    else {
      this.#set(key, text);
      const row = patch.row as { complete?: unknown; text?: unknown } | null | undefined;
      if (row?.complete === false && typeof row.text === "string")
        this.#streaming.set(key, row.text);
      else this.#streaming.delete(key);
    }
  }
  /**
   * Start a whole-thread pass (the SDK's "all"): every key put until the pass closes is still
   * current. False when native holds nothing to diff against, so the caller resets instead.
   */
  begin(): boolean {
    if (!this.#held) return false;
    this.#pass = new Set();
    return true;
  }
  /** A key put while a pass is open. */
  touch(key: string): void {
    this.#pass?.add(key);
  }
  /** Close the pass: what native holds that it did not put, as removals to send. */
  close(epoch: number): [string, () => Record<string, unknown>][] {
    const pass = this.#pass;
    this.#pass = undefined;
    if (!pass) return [];
    const removals: [string, () => Record<string, unknown>][] = [];
    for (const [key, text] of this.#entries)
      if (removable.test(key) && !pass.has(key))
        removals.push([key, () => ({ ...(JSON.parse(text) as object), row: null, epoch })]);
    return removals;
  }
  get passing(): boolean {
    return this.#pass !== undefined;
  }
  clear(): void {
    this.#entries.clear();
    this.#streaming.clear();
    this.#bytes = 0;
  }
  #set(key: string, text: string): void {
    this.#bytes += text.length - (this.#entries.get(key)?.length ?? 0);
    this.#entries.set(key, text);
  }
  #forget(key: string): void {
    this.#streaming.delete(key);
    this.#bytes -= this.#entries.get(key)?.length ?? 0;
    this.#entries.delete(key);
  }
}

/**
 * The ledgers of the threads native keeps, most recent last. Native keeps at most `count`
 * threads; the shelf keeps no more, and lets the oldest go past `bytes` (UTF-16 units) as well.
 */
export class LedgerShelf {
  #ledgers = new Map<string, NativeLedger>();
  readonly #count: number;
  readonly #bytes: number;

  constructor(count: number, bytes: number) {
    this.#count = count;
    this.#bytes = bytes;
  }
  /**
   * The ledger for opening `threadId`. `warm`: native kept its copy. A cold open, or a warm one
   * this shelf no longer remembers, starts empty and resets native first.
   */
  open(threadId: string, warm: boolean): NativeLedger {
    const known = this.#ledgers.get(threadId);
    this.#ledgers.delete(threadId);
    const ledger = warm && known ? known : new NativeLedger(threadId);
    if (warm && known) ledger.hold();
    this.#ledgers.set(threadId, ledger);
    this.trim();
    return ledger;
  }
  /** Let the least recently opened go past the count or the byte budget; never the newest. */
  trim(): void {
    let total = 0;
    for (const ledger of this.#ledgers.values()) total += ledger.bytes;
    for (const [id, ledger] of this.#ledgers) {
      if (this.#ledgers.size <= 1) break;
      if (this.#ledgers.size <= this.#count && total <= this.#bytes) break;
      total -= ledger.bytes;
      this.#ledgers.delete(id);
    }
  }
}
