import { join } from "node:path";
import {
  readSpadeServerFile,
  readSpadeTokenFile,
  type SpadeConnection,
  type SpadeEndpoint,
} from "@ace/service/spade";

/** A Spade this app can reach: where it listens, and the token its API needs. */
export type LocalSpade = SpadeEndpoint & SpadeConnection;

export interface EndpointWatchOptions {
  /** `<ACE_HOME>/spade`; undefined when the app's daemon isn't on this machine. */
  dataDir: string | undefined;
  /** A file's text, or undefined when it can't be read. */
  readText(path: string): Promise<string | undefined>;
  /**
   * Calls `changed` on any change in `directory`, and `lost` once it can't watch any more (the
   * folder went away); undefined when it can't be watched (yet).
   */
  watch(directory: string, changed: () => void, lost: () => void): (() => void) | undefined;
  now(): number;
  /** Spade's files changed: what `current` answers may be different now. */
  onChange(): void;
}

/** How long a reading holds while the folder can't be watched (it doesn't exist yet, say). */
const unwatchedMs = 2_000;

/**
 * Spade's `server.json` and token file, read when asked and again after they change. Spade
 * writes the token and then `server.json` on every start, so a change to either drops the
 * reading; while the folder can't be watched a reading holds two seconds.
 */
export function spadeEndpointWatch(options: EndpointWatchOptions) {
  const { dataDir } = options;
  let reading: Promise<LocalSpade | undefined> | undefined;
  let readAt = 0;
  let unwatch: (() => void) | undefined;
  let closed = false;

  const changed = () => {
    reading = undefined;
    options.onChange();
  };
  const ensureWatch = () => {
    if (unwatch || closed || !dataDir) return;
    const stop = options.watch(dataDir, changed, () => {
      if (unwatch !== stop) return;
      unwatch = undefined;
      changed();
    });
    unwatch = stop;
  };
  const read = async (): Promise<LocalSpade | undefined> => {
    if (!dataDir) return undefined;
    // The token first: Spade writes it before `server.json`, so a fresh server.json never
    // pairs with the previous run's token for long (a 401 asks again, see `refresh`).
    const token = await options.readText(join(dataDir, "token"));
    const server = await options.readText(join(dataDir, "server.json"));
    if (token === undefined || server === undefined) return undefined;
    const parsed = readSpadeServerFile(server);
    const secret = readSpadeTokenFile(token);
    if (!parsed.ok || !secret) return undefined;
    return { ...parsed.endpoint, token: secret };
  };

  return {
    /** The Spade to reach now, if any. */
    current(): Promise<LocalSpade | undefined> {
      ensureWatch();
      const fresh = unwatch !== undefined || options.now() - readAt < unwatchedMs;
      if (reading && fresh) return reading;
      readAt = options.now();
      reading = read();
      return reading;
    },
    /** Read the files again now: a request found Spade gone or its token stale. */
    refresh(): Promise<LocalSpade | undefined> {
      reading = undefined;
      return this.current();
    },
    close() {
      closed = true;
      unwatch?.();
      unwatch = undefined;
    },
  };
}

export type SpadeEndpointWatch = ReturnType<typeof spadeEndpointWatch>;
