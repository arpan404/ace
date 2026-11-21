import { generateSecret, type CredentialRuntime } from "./credential-runtime.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, StatementSync, SQLOutputValue } from "node:sqlite";
import {
  DeviceId,
  Device,
  type DeviceScope,
  type InstallId,
  type PairingLinkProof,
} from "@ace/protocol";

export type { Device } from "@ace/protocol";
export type Scope = DeviceScope;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/**
 * Whether a device may act with `scope`. A member's socket on an organization's host that only
 * talks to Spade (`spadeOnly`, ADR 0206 §2.2) is refused everywhere else, whatever its scopes.
 */
export const allows = (
  device: (Pick<Device, "scopes"> & { spadeOnly?: boolean | undefined }) | undefined,
  scope: Scope,
) =>
  device !== undefined &&
  device.spadeOnly !== true &&
  (device.scopes.includes(scope) ||
    (scope === "projects" || scope === "accounts"
      ? device.scopes.includes("desktop")
      : device.scopes.includes("admin")));

/** Not revoked, and its access hasn't run out. */
export const activeDevice = (
  device: Pick<Device, "revokedAt" | "expiresAt"> | undefined,
  at: number,
): device is Device =>
  device !== undefined &&
  device.revokedAt === null &&
  (device.expiresAt === undefined || device.expiresAt === null || device.expiresAt > at);

/**
 * A paired device as one of its credentials authenticated it. The generation names that
 * credential: pairing the same install again replaces it, and everything the old credential
 * opened (tickets, sockets, leases) stops carrying authority (ADR 0115). It is derived from the
 * stored hash, never the token, so holding it authenticates nothing.
 */
export type PairedDevice = Device & {
  generation: string;
  /**
   * Its pairing link was made by someone with the person's standing (ADR 0190): a paired or
   * account device that is the person's, or the host token right after a browser sign-in. A
   * link the host token alone made, or one from before links said, makes a device with no more
   * standing than its maker: person-only actions need a fresh sign-in.
   */
  person: boolean;
};
/** Only a link a person made says so; devices paired before links said are not the person's. */
const personOf = (row: Record<string, SQLOutputValue>) => row.person === 1;
/**
 * Who a socket or channel speaks for. A revocable actor is a paired device and carries the
 * generation of the credential that opened it; the host and account devices are not revocable.
 */
export type SessionActor = Device & {
  revocable: boolean;
  generation?: string | undefined;
  /**
   * For a paired device: its link was the person's (`PairedDevice.person`, ADR 0190). An account
   * device's standing is proven on its socket instead.
   */
  person?: boolean | undefined;
  /**
   * For a member admitted to an organization's host (ADR 0206 §2.2): who, in which organization,
   * with which role. Their standing is proven on the socket, as a person's is.
   */
  member?: { org: string; role: string; account: string } | undefined;
  /**
   * A member whose role holds no admin on the host: their socket reaches Spade, where shared
   * bots live, and nothing else (`allows` refuses them every scope).
   */
  spadeOnly?: boolean | undefined;
};
const generationOf = (row: Record<string, SQLOutputValue>) =>
  hash(`generation:${String(row.token_hash)}`).slice(0, 32);

function decode(row: Record<string, SQLOutputValue>): Device {
  return Device.parse({
    id: row.id,
    name: row.name,
    scopes: JSON.parse(String(row.scopes)),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at ?? null,
  });
}

/** Shares the event store's SQLite connection; credentials never leave this module. */
export class Devices {
  private revoked = new Set<(id: string) => void>();
  onRevoke(listener: (id: string) => void): () => void {
    if (this.revoked.size >= 32) throw new Error("Device revocation subscriber limit");
    this.revoked.add(listener);
    return () => {
      this.revoked.delete(listener);
    };
  }
  private rescoped = new Set<(id: string) => void>();
  /** Hear a device's scopes change (`setScopes`): what it holds open may need ending. */
  onRescope(listener: (id: string) => void): () => void {
    if (this.rescoped.size >= 32) throw new Error("Device rescope subscriber limit");
    this.rescoped.add(listener);
    return () => {
      this.rescoped.delete(listener);
    };
  }
  private runtime: CredentialRuntime;
  private insert: StatementSync;
  private byId: StatementSync;
  private byToken: StatementSync;
  private updateSeen: StatementSync;
  private listing: StatementSync;
  private revocation: StatementSync;
  private rescope: StatementSync;
  private byInstall: StatementSync;
  private rekey: StatementSync;
  private stamp: StatementSync;
  private orphans: StatementSync;
  private fold: StatementSync;
  private unfold: StatementSync;
  private folded: StatementSync;
  private linkAccount: StatementSync;
  private unperson: StatementSync;
  constructor(db: DatabaseSync, runtime: CredentialRuntime) {
    this.runtime = runtime;
    const live = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
    this.byInstall = db.prepare(
      `SELECT * FROM devices WHERE install_id = ? AND merged_into IS NULL AND ${live} ORDER BY last_seen_at DESC, id LIMIT 1`,
    );
    // A new credential is a new proof: the account device it was linked to proves it again.
    this.rekey = db.prepare(
      "UPDATE devices SET name = ?, token_hash = ?, scopes = ?, last_seen_at = ?, expires_at = ?, person = ?, standing_key = ?, account_link = NULL WHERE id = ?",
    );
    this.unperson = db.prepare(
      "UPDATE devices SET person = 0, standing_key = NULL WHERE person = 1 OR standing_key IS NOT NULL",
    );
    this.linkAccount = db.prepare("UPDATE devices SET account_link = ? WHERE id = ?");
    this.stamp = db.prepare("UPDATE devices SET install_id = ? WHERE id = ?");
    // Records an install left behind before it said who it is: the same name, never used since
    // the install paired again.
    this.orphans = db.prepare(
      `SELECT * FROM devices WHERE id != ? AND install_id IS NULL AND merged_into IS NULL AND name = ? AND last_seen_at < ? AND ${live} AND scopes NOT LIKE '%"desktop"%' AND scopes NOT LIKE '%"user-browser"%'`,
    );
    this.fold = db.prepare(
      "UPDATE devices SET merged_into = ? WHERE (id = ? OR merged_into = ?) AND revoked_at IS NULL",
    );
    this.unfold = db.prepare("UPDATE devices SET merged_into = NULL WHERE id = ?");
    this.folded = db.prepare(
      "SELECT id FROM devices WHERE merged_into = ? AND revoked_at IS NULL ORDER BY id",
    );
    this.insert = db.prepare(
      "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, expires_at, install_id, person, standing_key) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
    );
    this.byId = db.prepare("SELECT * FROM devices WHERE id = ?");
    this.byToken = db.prepare(
      "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    );
    this.updateSeen = db.prepare(
      "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
    );
    this.listing = db.prepare(
      "SELECT * FROM devices WHERE merged_into IS NULL ORDER BY created_at, id",
    );
    this.revocation = db.prepare(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    );
    this.rescope = db.prepare("UPDATE devices SET scopes = ? WHERE id = ? AND revoked_at IS NULL");
  }
  /**
   * `expiresAt` null: access lasts until revoked. An install that already holds a device here
   * (ADR 0115) keeps that record and its id: the new pairing's name, scopes and expiry replace
   * the old ones and the old token stops working. `person`: the link's maker had the person's
   * standing (ADR 0190), and `standingKey` the key the device proves that standing with.
   */
  create(
    name: string,
    granted: Scope[],
    at: number,
    expiresAt: number | null = null,
    installId?: InstallId,
    person = false,
    standingKey?: string,
  ): { device: Device; token: string } {
    // A device that names no standing key can never prove the person's standing, so it never
    // carries the person's bit either (ADR 0190).
    const personal = person && standingKey !== undefined;
    const key = personal ? standingKey : undefined;
    const token = generateSecret(this.runtime.randomBytes);
    const held = installId === undefined ? undefined : this.byInstall.get(installId, at);
    if (held) {
      const device = Device.parse({
        ...decode(held),
        name,
        scopes: granted,
        lastSeenAt: at,
        expiresAt,
      });
      this.rekey.run(
        device.name,
        hash(token),
        JSON.stringify(device.scopes),
        at,
        device.expiresAt ?? null,
        personal ? 1 : 0,
        key ?? null,
        device.id,
      );
      return { device, token };
    }
    // Always minted here: an install id is not a secret, so a record named by one would share
    // whatever that install's account device keeps under the same id (ADR 0115).
    const id = DeviceId.parse(this.runtime.id());
    const device = Device.parse({
      id,
      name,
      scopes: granted,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
      expiresAt,
    });
    this.insert.run(
      device.id,
      device.name,
      hash(token),
      JSON.stringify(device.scopes),
      device.createdAt,
      device.lastSeenAt,
      device.expiresAt ?? null,
      installId ?? null,
      personal ? 1 : 0,
      key ?? null,
    );
    return { device, token };
  }
  /**
   * `id` connected from app install `installId` (ADR 0115): its record learns the install, and
   * records the install left behind before installs had ids fold into it (the same name, never
   * used since this one was made, and no access this one lacks), so the install is listed once.
   * A folded record that is used again comes back on its own (`authenticate`), so folding never
   * takes access away.
   *
   * An install id is not a secret, so naming one proves nothing: a record another credential
   * already holds for that install is never folded, and the caller is not stamped beside it.
   * Only a pairing code from that install takes such a record over (`create`).
   */
  recognize(id: string, installId: InstallId, at: number): void {
    const row = this.byId.get(id);
    if (!row || row.revoked_at !== null) return;
    if (row.merged_into !== null) this.unfold.run(id);
    // A record of another install keeps its install: a credential moved between installs is
    // still the record the owner paired.
    if (row.install_id !== null && row.install_id !== installId) return;
    if (row.install_id === null) {
      const other = this.byInstall.get(installId, at);
      if (other && other.id !== id) return;
      this.stamp.run(installId, id);
    }
    const survivor = decode(row);
    for (const orphan of this.orphans.all(id, String(row.name), Number(row.created_at), at))
      if (decode(orphan).scopes.every((scope) => allows(survivor, scope)))
        this.fold.run(id, String(orphan.id), String(orphan.id));
  }
  /**
   * The ace account device `accountId` proved, in its own admitted hello, that it holds the
   * credential of paired record `link.deviceId` (ADR 0115): from then on the two are one device
   * for command receipts, until that record's credential is replaced. False, linking nothing,
   * when the proof doesn't match an active paired credential. Local-only credentials (the
   * desktop app's, "Use my Chrome") never link.
   */
  link(accountId: string, link: PairingLinkProof, at: number): boolean {
    const row = this.byId.get(link.deviceId);
    if (!row || link.deviceId === accountId || !activeDevice(decode(row), at)) return false;
    const scopes = decode(row).scopes;
    if (scopes.includes("desktop") || scopes.includes("user-browser")) return false;
    const expected = createHmac("sha256", String(row.token_hash))
      .update(`ace-link/v1\n${link.deviceId}\n${accountId}`)
      .digest();
    const given = Buffer.from(link.proof, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    this.linkAccount.run(accountId, link.deviceId);
    return true;
  }
  /**
   * Whether `a` and `b` are one device for command receipts (ADR 0115): a paired record and
   * the ace account device that proved it holds that record's credential (`link`), or two
   * paired records proven by the same account device. Naming an install proves nothing, so an
   * install stamp alone links no one; an id with no paired record is an account device.
   */
  sameInstall(a: string, b: string): boolean {
    if (a === b) return true;
    const proven = (id: string): string | null => {
      const row = this.byId.get(id);
      return row ? (row.account_link === null ? null : String(row.account_link)) : id;
    };
    const left = proven(a);
    return left !== null && left === proven(b);
  }
  get(id: string): Device | undefined {
    const row = this.byId.get(id);
    return row ? decode(row) : undefined;
  }
  /** The device whose record a pairing from `installId` would take over, if any. */
  heldBy(installId: InstallId, at: number): string | undefined {
    const row = this.byInstall.get(installId, at);
    return row ? String(row.id) : undefined;
  }
  /**
   * `id` while it is active and still holds the credential of `generation`: a session opened
   * with a credential that has since been replaced carries no authority, not even the new one's.
   */
  current(id: string, generation: string | undefined, at: number): PairedDevice | undefined {
    const row = this.byId.get(id);
    if (!row || generation === undefined || generationOf(row) !== generation) return undefined;
    const device = decode(row);
    return activeDevice(device, at) ? { ...device, generation, person: personOf(row) } : undefined;
  }
  /**
   * The key `id` proves the person's standing with (ADR 0190), while it is active, still holds
   * the credential of `generation`, and was paired from a person's link naming one.
   */
  standingKeyOf(id: string, generation: string | undefined, at: number): string | undefined {
    const row = this.byId.get(id);
    if (!row || !this.current(id, generation, at) || !personOf(row)) return undefined;
    return typeof row.standing_key === "string" ? row.standing_key : undefined;
  }
  /** No paired device is the person's any more: the machine's owner changed (ADR 0190). */
  clearPerson(): void {
    this.unperson.run();
  }
  authenticate(token: string, at: number): PairedDevice | undefined {
    const row = this.byToken.get(hash(token), at);
    if (!row) return undefined;
    // Its own credential in use: it is a device of its own after all.
    if (row.merged_into !== null) this.unfold.run(String(row.id));
    const device = decode(row);
    this.touch(device.id, at);
    device.lastSeenAt = at;
    return { ...device, generation: generationOf(row), person: personOf(row) };
  }
  /** An ace account device connected: the paired record of the same install is seen too. */
  seen(installId: string, at: number): void {
    const row = this.byInstall.get(installId, at);
    if (row) this.touch(String(row.id), at);
  }
  touch(id: string, at: number): void {
    Device.shape.lastSeenAt.parse(at);
    this.updateSeen.run(at, id);
  }
  list(): Device[] {
    return this.listing.all().map(decode);
  }
  /**
   * Gives active device `id` exactly `scopes`, keeping its credential, id and expiry. Every
   * check reads the stored record, so the next request or socket message holds the new scopes.
   * Undefined when `id` isn't active.
   */
  setScopes(id: string, scopes: readonly Scope[], at: number): Device | undefined {
    const row = this.byId.get(id);
    const held = row ? decode(row) : undefined;
    if (!activeDevice(held, at)) return undefined;
    const device = Device.parse({ ...held, scopes: [...new Set(scopes)] });
    this.rescope.run(JSON.stringify(device.scopes), device.id);
    for (const listener of this.rescoped) listener(device.id);
    return device;
  }
  revoke(id: string, at: number): boolean {
    return this.revokeInstall(id, at).length > 0;
  }
  /**
   * Revokes `id` and the records folded into it: the owner removed that install. Returns every
   * id it revoked, `id` first, so each one's sockets, tickets and channels close; empty when
   * `id` was not active.
   */
  revokeInstall(id: string, at: number): string[] {
    Device.shape.revokedAt.parse(at);
    const folded = this.folded.all(id).map((row) => String(row.id));
    if (this.revocation.run(at, id).changes === 0) return [];
    const revoked = [id];
    for (const other of folded) if (this.revocation.run(at, other).changes > 0) revoked.push(other);
    for (const each of revoked) this.notify(each);
    return revoked;
  }
  private notify(id: string): void {
    for (const listener of this.revoked) {
      try {
        listener(id);
      } catch {
        /* One subscriber cannot preserve another's authority. */
      }
    }
  }
}
