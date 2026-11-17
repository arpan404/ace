/*
 * The open thread counts as read once the person has stayed at its last answer a moment, as the
 * desktop's transcript marks it (`seen.ts`): the read cursor goes to the daemon through the
 * newest event the phone holds, and again as answers arrive while the reader stays at the end.
 * A thread left before then keeps its finished-result check. A thread marked unread by hand is
 * read again the first time this visit reaches its end; after that the choice stands until the
 * thread is opened anew.
 */

/** How long the reader stays at the end before the thread counts as read (the desktop's dwell). */
export const readDwellMs = 800;

export interface ReadMarkHost {
  /** The newest event sequence the phone holds for the thread. */
  cursor(): number | undefined;
  /** The thread is marked unread by hand (`thread.read` with `unread`). */
  markedUnread(): boolean;
  /** Moves this device's read cursor (`thread.markRead`); coalesced by the SDK. */
  markRead(lastSeenSeq: number): void;
  /** Clears the hand-set unread (`thread.read` with `unread: false`). */
  clearUnread(): void;
  schedule(ms: number, run: () => void): () => void;
}

export class ReadMark {
  readonly #host: ReadMarkHost;
  #atEnd = false;
  /** The reader has stayed at the end through the dwell. */
  #read = false;
  #cancel: (() => void) | undefined;
  #marked = 0;
  /** The reader has reached the end once this visit. */
  #visited = false;

  constructor(host: ReadMarkHost) {
    this.#host = host;
  }

  /** Native says whether the reader sits at the transcript's live end. */
  atEnd(at: boolean): void {
    if (at === this.#atEnd) return;
    this.#atEnd = at;
    this.#read = false;
    this.#cancel?.();
    this.#cancel = undefined;
    if (!at) return;
    this.#cancel = this.#host.schedule(readDwellMs, () => {
      this.#cancel = undefined;
      this.#read = true;
      // Only this visit's first arrival at the end: a Mark unread chosen after it stands.
      if (!this.#visited && this.#host.markedUnread()) this.#host.clearUnread();
      this.#visited = true;
      this.moved();
    });
  }

  /** The thread's cursor moved. */
  moved(): void {
    if (!this.#read) return;
    const cursor = this.#host.cursor();
    if (cursor === undefined || cursor <= this.#marked) return;
    this.#marked = cursor;
    this.#host.markRead(cursor);
  }

  dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#atEnd = false;
    this.#read = false;
  }
}
