import {
  ClientError,
  type ClientCore,
  type ItemsWindowInput,
  type RequestOptions,
  type ThreadSource,
} from "@ace/client";

/** One reading session's provenance. Cached rows never become current merely on reconnect. */
export class HistoryWindowReads {
  cached = false;
  readonly #client: ClientCore;

  constructor(client: ClientCore) {
    this.#client = client;
  }

  async read(input: ItemsWindowInput, options: RequestOptions = {}) {
    try {
      return await this.#client.itemsWindow(input, options);
    } catch (error) {
      if (!(error instanceof ClientError) || !["offline", "timeout"].includes(error.code))
        throw error;
      const kept = await this.#client.cachedItemsWindow(input, options);
      if (!kept) throw error;
      this.cached = true;
      return kept.page;
    }
  }
}

/** The transport handshake precedes subscription confirmation. Keep the cached view until then. */
export async function confirmHistorySource(
  client: ClientCore,
  source: ThreadSource,
  signal: AbortSignal,
): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const connection = client.connectionState();
  await new Promise<void>((resolve, reject) => {
    const stops: (() => void)[] = [];
    const finish = (error?: unknown) => {
      for (const stop of stops.splice(0)) stop();
      bounded.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(bounded.reason);
    const check = () => {
      if (bounded.aborted) return aborted();
      if (connection.getSnapshot() !== "ready") return finish();
      if (source.error) return finish(source.error);
      if (source.thread && !source.syncing && !source.unconfirmed) finish();
    };
    stops.push(source.observe(check), connection.subscribe(check));
    bounded.addEventListener("abort", aborted, { once: true });
    check();
  });
}
