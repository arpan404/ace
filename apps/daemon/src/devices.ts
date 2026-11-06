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
      `SELECT id FROM devices WHERE id != ? AND install_id IS NULL AND merged_into IS NULL AND name = ? AND last_seen_at < ? AND ${live} AND scopes NOT LIKE '%"desktop"%' AND scopes NOT LIKE '%"user-browser"%'`,
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
    );
    return { device, token };
  }
  /**
   * `id` connected from app install `installId` (ADR 0115): its record learns the install, and
   * the install's other records fold into it, so the install is listed once. That covers a
   * record stamped earlier and those left behind by pairing again before installs had ids (the
   * same name, never used since this one was made). A folded record that is used again comes
   * back on its own (`authenticate`), so folding never takes access away.
   */
  recognize(id: string, installId: InstallId, at: number): void {
    const row = this.byId.get(id);
    if (!row || row.revoked_at !== null) return;
    if (row.merged_into !== null) this.unfold.run(id);
    if (row.install_id === installId) return;
    // A record of another install keeps its install: a credential moved between installs is
    // still the record the owner paired.
    if (row.install_id !== null) return;
    const other = this.byInstall.get(installId, at);
    if (other && other.id !== id) this.fold.run(id, String(other.id), String(other.id));
    this.stamp.run(installId, id);
    for (const orphan of this.orphans.all(id, String(row.name), Number(row.created_at), at))
      this.fold.run(id, String(orphan.id), String(orphan.id));
  }
  get(id: string): Device | undefined {
    const row = this.byId.get(id);
    return row ? decode(row) : undefined;
  }
  authenticate(token: string, at: number): Device | undefined {
    const row = this.byToken.get(hash(token), at);
    if (!row) return undefined;
    // Its own credential in use: it is a device of its own after all.
    if (row.merged_into !== null) this.unfold.run(String(row.id));
    const device = decode(row);
    this.touch(device.id, at);
    device.lastSeenAt = at;
    return device;
  }
  touch(id: string, at: number): void {
    Device.shape.lastSeenAt.parse(at);
    this.updateSeen.run(at, id);
  }
  list(): Device[] {
    return this.listing.all().map(decode);
  }
  /** Revokes `id` and the records folded into it: the owner removed that install. */
  revoke(id: string, at: number): boolean {
    Device.shape.revokedAt.parse(at);
    const folded = this.folded.all(id).map((row) => String(row.id));
    if (this.revocation.run(at, id).changes === 0) return false;
    for (const other of folded) if (this.revocation.run(at, other).changes > 0) this.notify(other);
    this.notify(id);
    return true;
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
