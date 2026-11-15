import type { Revocation, RevocationResult } from "./grants.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/*
 * Clients' media connections, held by the daemon (docs/media/plan.md "Media connection
 * authorization"). Each belongs to the main session that asked for it with `media.connect`,
 * that session's device and the device's admission; it lives no longer than any of them.
 *
 * - `connect` mints the id and a single-use 32-byte ticket, valid 30 s, and grants it to
 *   ace-media with `media.ticket`.
 * - `view` turns a subscribe naming a connection into `viewer.open`, only for a connection of
 *   the same main session, or of the same device under the same admission: a client that
 *   subscribes on a channel of its own (iOS opens screen and devices channels beside its main
 *   session) owns that device's connections there too. Another device, or the same device under
 *   another admission (another pairing generation, an account), is refused.
 * - `sessionClosed`, `revoke` and ace-media leaving end connections. From a revocation on,
 *   nothing more is minted for its owner.
 *
 * Every grant and revocation carries the next number of one issue sequence (`MediaIssue`), so
 * ace-media can refuse a grant issued before a revocation that reached it first.
 */

type Message<T extends ToMedia["type"]> = Extract<ToMedia, { type: T }>;
export type MediaOwner = Message<"media.ticket">["owner"];
export type MediaAdmission = MediaOwner["admission"];
type ViewerOpen = Message<"viewer.open">;

export const ticketTtlMs = 30_000;
/** Media connections one main session may hold at once (one per daemon is the normal case). */
export const connectionsPerSession = 4;
/** How long a lapsed account admission blocks new grants: its sessions close well within it. */
export const accountBlockMs = 5_000;

/** The daemon's one issue sequence for grants and revocations. */
export class MediaIssue {
  #last = 0;
  next(): number {
    this.#last += 1;
    return this.#last;
  }
}

export type MediaConnectionsPort = {
  /** `MediaSupervisor.send`: false when ace-media can't take it now. */
  send(message: ToMedia, payload?: Uint8Array): boolean;
  revoke(message: Revocation): Promise<RevocationResult>;
  /** ace-media's loopback listener port, once it is up. */
  directPort(): number | undefined;
  /** Keeps ace-media running (starting it if needed) until the release is called. */
  need(): () => void;
  /** Resolves after `ms`, so a connect can wait for ace-media to come up. */
  sleep(ms: number): Promise<void>;
};

export type MediaConnectionsOptions = {
  port: MediaConnectionsPort;
  issue: MediaIssue;
  /** The daemon's wall clock, in Unix ms: ace-media checks `expiresAt` against the same one. */
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
  /** Revocation and close ids. */
  id: () => string;
};

export type MediaConnectGrant =
  | { ok: true; connection: string; url?: string; ticket: string; expiresAt: number }
  | { ok: false; code: "unavailable" | "limit" | "refused"; message: string };

type Held = { owner: MediaOwner; open: boolean; release: () => void };

/** How long `media.connect` waits for ace-media to start. */
export const startWaitMs = 5_000;
const startPollMs = 20;

function base64url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += alphabet[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

function sameAdmission(a: MediaAdmission, b: MediaAdmission): boolean {
  if (a.kind === "pairing" && b.kind === "pairing") return a.generation === b.generation;
  if (a.kind === "account" && b.kind === "account") return a.account === b.account;
  return false;
}

export class MediaConnections {
  readonly #options: MediaConnectionsOptions;
  readonly #held = new Map<string, Held>();
  /**
   * Owners revoked: nothing more is minted for them. A pairing's credential never comes back, so
   * its block stands; an account admission may (the machine is put back on the account), so its
   * block covers only the moments until the main sessions it admitted have closed.
   */
  readonly #revoked: { device: string; admission?: MediaAdmission; until: number }[] = [];

  constructor(options: MediaConnectionsOptions) {
    this.#options = options;
  }

  #isRevoked(owner: MediaOwner): boolean {
    const now = this.#options.now();
    return this.#revoked.some(
      (r) =>
        r.until > now &&
        r.device === owner.device &&
        (!r.admission || sameAdmission(r.admission, owner.admission)),
    );
  }

  /**
   * `media.connect` from an authenticated main session. A connection keeps ace-media running for
   * as long as it is held; when nothing had started it yet, this waits up to `startWaitMs` for it.
   */
  async connect(owner: MediaOwner): Promise<MediaConnectGrant> {
    const unavailable = {
      ok: false,
      code: "unavailable",
      message: "ace-media isn't serving viewers.",
    } as const;
    if (this.#isRevoked(owner))
      return { ok: false, code: "refused", message: "This device's access was revoked." };
    const mine = [...this.#held.values()].filter((h) => h.owner.session === owner.session);
    if (mine.length >= connectionsPerSession)
      return { ok: false, code: "limit", message: "Too many media connections." };
    const { port: media } = this.#options;
    const release = media.need();
    let port = media.directPort();
    for (let waited = 0; !port && waited < startWaitMs; waited += startPollMs) {
      await media.sleep(startPollMs);
      port = media.directPort();
    }
    // Revoked while it waited: nothing is minted for it.
    if (!port || this.#isRevoked(owner)) {
      release();
      return port
        ? { ok: false, code: "refused", message: "This device's access was revoked." }
        : unavailable;
    }
    const connection = `mc_${base64url(this.#options.randomBytes(18))}`;
    const ticket = this.#options.randomBytes(32);
    const ticketText = base64url(ticket);
    const expiresAt = this.#options.now() + ticketTtlMs;
    const sent = this.#options.port.send(
      {
        type: "media.ticket",
        connection,
        owner,
        issued: this.#options.issue.next(),
        expiresAt,
      },
      ticket,
    );
    ticket.fill(0);
    if (!sent) {
      release();
      return unavailable;
    }
    this.#held.set(connection, { owner, open: false, release });
    return {
      ok: true,
      connection,
      url: `ws://127.0.0.1:${port}/media`,
      ticket: ticketText,
      expiresAt,
    };
  }

  /**
   * The connection's owner, when `requester` may bind views on it: its own main session, or a
   * channel of the same device admitted the same way.
   */
  owned(requester: MediaOwner, connection: string): MediaOwner | undefined {
    const held = this.#held.get(connection);
    if (!held) return undefined;
    const { owner } = held;
    const same =
      owner.session === requester.session ||
      (owner.device === requester.device && sameAdmission(owner.admission, requester.admission));
    return same ? owner : undefined;
  }

  /**
   * A subscribe from `requester` naming `connection`: its `viewer.open`, with the connection's
   * owner on it. False when `requester` doesn't own the connection (`owned`), or ace-media can't
   * take the grant; the caller
   * refuses the subscribe or serves it on the main socket.
   */
  view(
    requester: MediaOwner,
    connection: string,
    viewer: Omit<ViewerOpen, "type" | "connection" | "owner" | "issued">,
  ): boolean {
    const owner = this.owned(requester, connection);
    if (!owner || this.#isRevoked(owner)) return false;
    return this.#options.port.send({
      type: "viewer.open",
      ...viewer,
      connection,
      owner,
      issued: this.#options.issue.next(),
    });
  }

  /** The owning main session closed: its connections close on the priority lane. */
  sessionClosed(session: string): Promise<RevocationResult[]> {
    const closing: Promise<RevocationResult>[] = [];
    for (const [connection, held] of this.#held) {
      if (held.owner.session !== session) continue;
      this.#drop(connection);
      closing.push(
        this.#options.port.revoke({
          type: "connection.close",
          id: this.#options.id(),
          connection,
          reason: "session-closed",
        }),
      );
    }
    return Promise.all(closing);
  }

  /**
   * A device's credential was revoked or replaced (`admission` its pairing), or an account
   * admission lapsed (`admission` the account): its connections close and nothing more is minted
   * for it. No admission: every admission of the device.
   */
  revoke(device: string, admission?: MediaAdmission): Promise<RevocationResult> {
    const until =
      admission?.kind === "account"
        ? this.#options.now() + accountBlockMs
        : Number.POSITIVE_INFINITY;
    this.#revoked.push(admission ? { device, admission, until } : { device, until });
    for (const [connection, held] of this.#held)
      if (
        held.owner.device === device &&
        (!admission || sameAdmission(admission, held.owner.admission))
      )
        this.#drop(connection);
    return this.#options.port.revoke({
      type: "revoke",
      id: this.#options.id(),
      issued: this.#options.issue.next(),
      device,
      ...(admission ? { admission } : {}),
    });
  }

  /** ace-media's word on a connection. */
  received(message: FromMedia): void {
    if (message.type === "connection.open") {
      const held = this.#held.get(message.connection);
      if (held) held.open = true;
    } else if (message.type === "connection.closed") {
      this.#drop(message.connection);
    }
  }

  /** ace-media exited: every media connection ended with it; clients ask again. */
  exited(): void {
    // Deleting from a Map while iterating it is safe: dropped entries aren't visited again.
    for (const connection of this.#held.keys()) this.#drop(connection);
  }

  #drop(connection: string): void {
    const held = this.#held.get(connection);
    if (!held) return;
    this.#held.delete(connection);
    held.release();
  }

  /** The main sessions that hold a media connection now. */
  sessions(): Set<string> {
    return new Set([...this.#held.values()].map((h) => h.owner.session));
  }
}
