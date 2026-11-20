/**
 * One read of each page of a list at a time. The daemon pages a list from its cursor and
 * refuses a request for a cursor it has already moved past, so two views asking for the next
 * page at once (History and the Threads panel's Settled, each paging the same list) would have
 * the second fail. An ask for the page already out shares that read instead, and gets its
 * result, so neither sees a page refused. Each list keeps its own.
 */
export class PageOnce {
  #out: { key: string; read: Promise<void> } | undefined;
  /** `read` for `key`, unless a read of `key` is out: then that one. */
  run(key: string, read: () => Promise<void>): Promise<void> {
    const out = this.#out;
    if (out?.key === key) return out.read;
    const next = {
      key,
      read: read().finally(() => {
        if (this.#out === next) this.#out = undefined;
      }),
    };
    this.#out = next;
    return next.read;
  }
}

/** The key a `threads.page` request is shared under: its list and cursor. */
export const pageKey = (payload: { subscriptionId: string; before: { at: number; id: string } }) =>
  `${payload.subscriptionId}\n${payload.before.at}\n${payload.before.id}`;
