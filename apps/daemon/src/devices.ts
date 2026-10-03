import { generateSecret, type CredentialRuntime } from "./credential-runtime.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync, SQLOutputValue } from "node:sqlite";
import { DeviceId, Device, type DeviceScope } from "@ace/protocol";

export type { Device } from "@ace/protocol";
export type Scope = DeviceScope;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const allows = (device: Pick<Device, "scopes"> | undefined, scope: Scope) =>
  device !== undefined && (device.scopes.includes("admin") || device.scopes.includes(scope));

function decode(row: Record<string, SQLOutputValue>): Device {
  return Device.parse({
    id: row.id,
    name: row.name,
    scopes: JSON.parse(String(row.scopes)),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
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
  constructor(db: DatabaseSync, runtime: CredentialRuntime) {
    this.runtime = runtime;
    this.insert = db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, NULL)");
    this.byId = db.prepare("SELECT * FROM devices WHERE id = ?");
    this.byToken = db.prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL");
    this.updateSeen = db.prepare(
      "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
    );
    this.listing = db.prepare("SELECT * FROM devices ORDER BY created_at, id");
    this.revocation = db.prepare(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    );
  }
  create(name: string, granted: Scope[], at: number): { device: Device; token: string } {
    const token = generateSecret(this.runtime.randomBytes);
    const id = DeviceId.parse(this.runtime.id());
    const device = Device.parse({
      id,
      name,
      scopes: granted,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
    });
    this.insert.run(
      device.id,
      device.name,
      hash(token),
      JSON.stringify(device.scopes),
      device.createdAt,
      device.lastSeenAt,
    );
    return { device, token };
  }
  get(id: string): Device | undefined {
    const row = this.byId.get(id);
    return row ? decode(row) : undefined;
  }
  authenticate(token: string, at: number): Device | undefined {
    const row = this.byToken.get(hash(token));
    if (!row) return undefined;
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
  revoke(id: string, at: number): boolean {
    Device.shape.revokedAt.parse(at);
    if (this.revocation.run(at, id).changes === 0) return false;
    for (const listener of this.revoked) {
      try {
        listener(id);
      } catch {
        /* One subscriber cannot preserve another's authority. */
      }
    }
    return true;
  }
}
