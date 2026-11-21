import type { MediaConnectGranted } from "@ace/protocol";

/*
 * The fake daemon's ace-media for live views (X3: only ace-media delivers them). `media.connect`
 * grants a connection on a `fake-media:` address, which a client opens through `socket` (no
 * network: the fixture runs in one process). Once its hello arrives the connection is live, and
 * the fake browser, screen and devices send a view's pictures there, never on the main socket.
 * The client's acks on it go to whoever listens (`onAck`).
 */

/** What a client's media socket hears, as `@ace/client/media`'s `MediaSocketEvents`. */
export interface FakeMediaSocketEvents {
  open(): void;
  message(data: string | Uint8Array): void;
  close(code: number): void;
}

/** The scheme of every address this fixture grants. */
export const fakeMediaScheme = "fake-media:";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export class FakeMediaConnections {
  #next = 0;
  /** Live connections, by id: how to reach their client. */
  readonly #live = new Map<string, FakeMediaSocketEvents>();
  readonly #acks = new Set<(message: unknown) => void>();
  readonly #now: () => number;
  /** This daemon's name in every address it grants, so a client opens it on the right one. */
  readonly instance: string;

  constructor(now: () => number, instance = "local") {
    this.#now = now;
    this.instance = instance;
  }

  /** A grant for one connection, as `media.connect.result` carries it. */
  grant(): MediaConnectGranted {
    const id = ++this.#next;
    const connection = `mc_fake${String(id).padStart(8, "0")}`;
    const ticket = base64url(new Uint8Array(32).fill(id % 256));
    return {
      ok: true,
      connection,
      url: `${fakeMediaScheme}//${encodeURIComponent(this.instance)}/${connection}`,
      ticket,
      expiresAt: Math.round(this.#now()) + 30_000,
    };
  }

  /** Opens the connection `url` names, as a client's media socket does. */
  readonly socket = (url: string, events: FakeMediaSocketEvents) => {
    const connection = url.slice(url.lastIndexOf("/") + 1);
    let welcomed = false;
    queueMicrotask(() => events.open());
    return {
      send: (data: string | Uint8Array) => {
        if (!welcomed) {
          // The binary hello: the connection is the client's from here on.
          if (typeof data === "string") return;
          welcomed = true;
          this.#live.set(connection, events);
          queueMicrotask(() =>
            events.message(JSON.stringify({ type: "media.welcome", connection })),
          );
          return;
        }
        if (typeof data !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (typeof message === "object" && message && "type" in message && message.type === "ping")
          return void events.message(JSON.stringify({ type: "pong" }));
        for (const listener of this.#acks) listener(message);
      },
      close: () => {
        if (this.#live.get(connection) === events) this.#live.delete(connection);
        queueMicrotask(() => events.close(1000));
      },
    };
  };

  /** While false, ace-media can't serve any view: connections stay open, nothing is bound. */
  serving = true;

  /** Whether `connection` is open and served: a subscribe naming it is delivered there. */
  live(connection: string | undefined): boolean {
    return this.serving && connection !== undefined && this.#live.has(connection);
  }

  /** One picture's pieces on `connection`; false when it is gone. */
  send(connection: string, pieces: readonly Uint8Array[]): boolean {
    const events = this.#live.get(connection);
    if (!events) return false;
    for (const piece of pieces) events.message(piece);
    return true;
  }

  /** Hears every ack a client sends on any connection. */
  onAck(listener: (message: unknown) => void): () => void {
    this.#acks.add(listener);
    return () => void this.#acks.delete(listener);
  }

  /** ace-media went away: every connection closes, as a crash would close them. */
  dropAll(code = 1001): void {
    const all = [...this.#live.values()];
    this.#live.clear();
    for (const events of all) events.close(code);
  }
}

/** The daemon instance an address this fixture granted names (`FakeMediaConnections.instance`). */
export function fakeMediaInstance(url: string): string | undefined {
  if (!url.startsWith(`${fakeMediaScheme}//`)) return undefined;
  const rest = url.slice(`${fakeMediaScheme}//`.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? undefined : decodeURIComponent(rest.slice(0, slash));
}
