import { FilesRequestError } from "./errors.ts";
import type { EventPayload, FileMatches, Summary } from "./schemas.ts";

export type SearchEntry = {
  onMatches: (file: FileMatches) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  resolve: (summary: Summary) => void;
  reject: (error: Error) => void;
};

type Log = (message: string, fields: Record<string, unknown>) => void;

/** Running searches, keyed by the process's subscription number. */
export class SearchBook {
  readonly #searches = new Map<number, SearchEntry>();

  add(subscription: number, entry: SearchEntry): void {
    this.#searches.set(subscription, entry);
  }

  remove(subscription: number): void {
    const search = this.#searches.get(subscription);
    if (!search) return;
    this.#searches.delete(subscription);
    if (search.signal && search.onAbort) search.signal.removeEventListener("abort", search.onAbort);
  }

  /** Route one event; a subscription this book does not own is simply left alone. */
  dispatch(subscription: number, payload: EventPayload, log?: Log): void {
    const search = this.#searches.get(subscription);
    if (!search) return;
    if (payload.type === "matches") {
      try {
        search.onMatches(payload.file);
      } catch (error) {
        log?.("a search listener failed", { error: String(error) });
      }
      return;
    }
    if (payload.type === "searchFailed") {
      // The request was answered by its subscription, so a started search that stops reports here.
      this.remove(subscription);
      search.reject(new FilesRequestError(payload.code, payload.message));
      return;
    }
    if (payload.type === "searchDone") {
      this.remove(subscription);
      search.resolve(payload.summary);
    }
  }

  /** A process exit fails every search; searches cannot resume on the next run. */
  failAll(error: Error): void {
    for (const subscription of Array.from(this.#searches.keys())) {
      const search = this.#searches.get(subscription);
      this.remove(subscription);
      search?.reject(error);
    }
  }
}
