import { generateSecret, type CredentialRuntime } from "./credential-runtime.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DeviceId, Device, type DeviceScope } from "@ace/protocol";

export type { Device } from "@ace/protocol";
export type Scope = DeviceScope;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const allows = (device: Pick<Device, "scopes"> | undefined, scope: Scope) =>
  device !== undefined && (device.scopes.includes("admin") || device.scopes.includes(scope));

/** Shares the event store's SQLite connection; credentials never leave this module. */
export class Devices {
  private db: DatabaseSync;
  private runtime: CredentialRuntime;
  constructor(db: DatabaseSync, runtime: CredentialRuntime) {
    this.db = db;
    this.runtime = runtime;
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
    this.db
      .prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(
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
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
    if (!row) return undefined;
    return Device.parse({
      id: row.id,
      name: row.name,
      scopes: JSON.parse(String(row.scopes)),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    });
  }
  authenticate(token: string, at: number): Device | undefined {
    const row = this.db
      .prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hash(token));
    if (!row) return undefined;
    this.touch(String(row.id), at);
    return this.get(String(row.id));
  }
  touch(id: string, at: number): void {
    Device.shape.lastSeenAt.parse(at);
    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, id);
  }
  list(): Device[] {
    return this.db
      .prepare("SELECT id FROM devices ORDER BY created_at, id")
      .all()
      .map((row) => {
        const device = this.get(String(row.id));
        if (!device) throw new Error("Device disappeared during listing");
        return device;
      });
  }
  revoke(id: string, at: number): boolean {
    Device.shape.revokedAt.parse(at);
    return (
      this.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(at, id).changes !== 0
    );
  }
}
