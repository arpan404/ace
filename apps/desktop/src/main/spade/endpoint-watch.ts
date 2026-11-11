import { join } from "node:path";
import {
  readSpadeServerFile,
  readSpadeTokenFile,
  type SpadeConnection,
  type SpadeEndpoint,
} from "@ace/service/spade";
import { parseHostIdFile } from "../daemon/probe.ts";

/**
 * A Spade this app can reach: where it listens, the token its API needs, and the identity of
 * the daemon in the same home (`host-id`), so a window can tell whether the machine it shows is
 * this one.
 */
export type LocalSpade = SpadeEndpoint & SpadeConnection & { hostId: string };

export interface EndpointWatchOptions {
  /** The local daemon's ACE_HOME; undefined when the app's daemon isn't on this machine. */
  home: string | undefined;
  /** A file's text, or undefined when it can't be read. */
  readText(path: string): Promise<string | undefined>;
  /**
   * Calls `changed` on a change in `directory` with the file's name when the OS gives one, and
   * `lost` once it can't watch any more (the folder went away); undefined when it can't be
   * watched (yet).
   */
  watch(
    directory: string,
    changed: (file: string | undefined) => void,
    lost: () => void,
  ): (() => void) | undefined;
  now(): number;
  /** Spade's files changed: what `current` answers may be different now. */
  onChange(): void;
}

/** How long a reading holds while the folder can't be watched (it doesn't exist yet, say). */
const unwatchedMs = 2_000;

/** The files in Spade's folder that say where it is; the rest (its database, images) never do. */
const endpointFiles = new Set(["token", "server.json"]);

/** Whether two readings name the same Spade, reached the same way. */
export function sameLocalSpade(a: LocalSpade | undefined, b: LocalSpade | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.port === b.port &&
    a.token === b.token &&
    a.pid === b.pid &&
    a.api === b.api &&
    a.version === b.version &&
    a.hostId === b.hostId
  );
}

/**
 * Spade's `server.json` and token file (and the daemon's `host-id` beside them), read when
 * asked and again after they change. Spade's folder also holds its database, which changes on
 * every streamed word: only a change to `token` or `server.json` (or one the OS didn't name)
 * reads the files again, and the app hears of it only when what they say changed. While the
 * folder can't be watched a reading holds two seconds.
 */
export function spadeEndpointWatch(options: EndpointWatchOptions) {
  const { home } = options;
  const dataDir = home === undefined ? undefined : join(home, "spade");
  let reading: Promise<LocalSpade | undefined> | undefined;
  let readAt = 0;
  let unwatch: (() => void) | undefined;
  let closed = false;

  const changed = (file: string | undefined) => {
    if (file !== undefined && !endpointFiles.has(file)) return;
    const before = reading ?? Promise.resolve(undefined);
    const after = read();
    reading = after;
    void Promise.all([before, after]).then(([was, now]) => {
      if (reading === after && !closed && !sameLocalSpade(was, now)) options.onChange();
    });
  };
  const ensureWatch = () => {
    if (unwatch || closed || !dataDir) return;
    const stop = options.watch(dataDir, changed, () => {
      if (unwatch !== stop) return;
      unwatch = undefined;
      changed(undefined);
    });
    unwatch = stop;
  };
  const read = async (): Promise<LocalSpade | undefined> => {
    if (!dataDir || home === undefined) return undefined;
    // The token first: Spade writes it before `server.json`, so a fresh server.json never
    // pairs with the previous run's token for long (a 401 asks again, see `refresh`).
    const token = await options.readText(join(dataDir, "token"));
    const server = await options.readText(join(dataDir, "server.json"));
    const hostText = await options.readText(join(home, "host-id"));
    if (token === undefined || server === undefined || hostText === undefined) return undefined;
    const parsed = readSpadeServerFile(server);
    const secret = readSpadeTokenFile(token);
    const hostId = parseHostIdFile(hostText);
    // No daemon identity: a window can't tell this Spade is its machine's, so none is offered.
    if (!parsed.ok || !secret || !hostId) return undefined;
    return { ...parsed.endpoint, token: secret, hostId };
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
