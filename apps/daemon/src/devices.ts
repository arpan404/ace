import { generateSecret, type CredentialRuntime } from "./credential-runtime.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync, SQLOutputValue } from "node:sqlite";
import { DeviceId, Device, type DeviceScope, type InstallId } from "@ace/protocol";

export type { Device } from "@ace/protocol";
export type Scope = DeviceScope;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const allows = (device: Pick<Device, "scopes"> | undefined, scope: Scope) =>
  device !== undefined &&
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
export type PairedDevice = Device & { generation: string };
/**
 * Who a socket or channel speaks for. A revocable actor is a paired device and carries the
 * generation of the credential that opened it; the host and account devices are not revocable.
 */
export type SessionActor = Device & { revocable: boolean; generation?: string | undefined };
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
  private runtime: CredentialRuntime;
  private insert: StatementSync;
  private byId: StatementSync;
  private byToken: StatementSync;
  private updateSeen: StatementSync;
  private listing: StatementSync;
  private revocation: StatementSync;
  private byInstall: StatementSync;
  private rekey: StatementSync;
  private stamp: StatementSync;
  private orphans: StatementSync;
  private fold: StatementSync;
  private unfold: StatementSync;
  private folded: StatementSync;
  constructor(db: DatabaseSync, runtime: CredentialRuntime) {
    this.runtime = runtime;
    const live = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
    this.byInstall = db.prepare(
      `SELECT * FROM devices WHERE install_id = ? AND merged_into IS NULL AND ${live} ORDER BY last_seen_at DESC, id LIMIT 1`,
    );
    this.rekey = db.prepare(
      "UPDATE devices SET name = ?, token_hash = ?, scopes = ?, last_seen_at = ?, expires_at = ? WHERE id = ?",
    );
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
      "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, expires_at, install_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
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
  }
  /**
   * `expiresAt` null: access lasts until revoked. An install that already holds a device here
   * (ADR 0115) keeps that record and its id: the new pairing's name, scopes and expiry replace
   * the old ones and the old token stops working.
   */
  create(
    name: string,
    granted: Scope[],
    at: number,
    expiresAt: number | null = null,
    installId?: InstallId,
  ): { device: Device; token: string } {
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
        device.id,
      );
      return { device, token };
    }
    // A new install's device is named by the install itself, so its paired credential and its
    // ace account grant name one device on every path. An id already taken is never reused.
    const id = DeviceId.parse(
      installId !== undefined && !this.byId.get(installId) ? installId : this.runtime.id(),
    );
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
    return activeDevice(device, at) ? { ...device, generation } : undefined;
  }
  authenticate(token: string, at: number): PairedDevice | undefined {
    const row = this.byToken.get(hash(token), at);
    if (!row) return undefined;
    // Its own credential in use: it is a device of its own after all.
    if (row.merged_into !== null) this.unfold.run(String(row.id));
    const device = decode(row);
    this.touch(device.id, at);
    device.lastSeenAt = at;
    return { ...device, generation: generationOf(row) };
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
