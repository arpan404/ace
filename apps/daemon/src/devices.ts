import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DeviceId } from "@ace/protocol";

export const scopes = ["read", "operate", "admin"] as const;
export type Scope = (typeof scopes)[number];
export interface Device {
  id: DeviceId;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}
export const secret = () => randomBytes(32).toString("hex");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const allows = (device: Pick<Device, "scopes">, scope: Scope) =>
  device.scopes.includes("admin") || device.scopes.includes(scope);

/** Shares the event store's SQLite connection; credentials never leave this module. */
export class Devices {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  create(name: string, scopes: Scope[], at: number): { device: Device; token: string } {
    const token = secret();
    const id = DeviceId.parse(randomUUID());
    this.db
      .prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(id, name, hash(token), JSON.stringify(scopes), at, at);
    return { device: this.get(id)!, token };
  }
  get(id: string): Device | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
    if (!row) return undefined;
    const granted: unknown = JSON.parse(String(row.scopes));
    if (
      !Array.isArray(granted) ||
      !granted.every((value): value is Scope => scopes.includes(value))
    )
      throw new Error("Invalid stored device scopes");
    return {
      id: DeviceId.parse(row.id),
      name: String(row.name),
      scopes: granted,
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
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
    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, id);
  }
  list(): Device[] {
    return this.db
      .prepare("SELECT id FROM devices ORDER BY created_at, id")
      .all()
      .map((row) => this.get(String(row.id))!);
  }
  revoke(id: string, at: number): boolean {
    return (
      this.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(at, id).changes !== 0
    );
  }
}
