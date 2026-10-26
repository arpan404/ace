import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { DeviceScope } from "@ace/protocol";
import { z } from "zod";
import type { Scope } from "./devices.ts";

/** A pairing link waiting to be redeemed. Its code is known only by its hash. */
export interface PendingCode {
  id: string;
  expiresAt: number;
  scopes: Scope[];
  label?: string | undefined;
  deviceTtlMs?: number | undefined;
}

/**
 * Where pairing links wait. `take` is the single use: it removes the link as it returns it, so
 * one code can never pair two devices.
 */
export interface PairingCodeStore {
  put(codeHash: string, pending: PendingCode): void;
  take(codeHash: string): PendingCode | undefined;
  /** Unexpired links, oldest expiry first, then in the order they were made; expired ones are dropped on the way. */
  pending(now: number): PendingCode[];
  remove(id: string): boolean;
  clear(): void;
}

/** Links that last as long as the process, for embedded servers and tests. */
export class MemoryPairingCodes implements PairingCodeStore {
  private readonly codes = new Map<string, PendingCode>();
  put(codeHash: string, pending: PendingCode): void {
    this.codes.set(codeHash, pending);
  }
  take(codeHash: string): PendingCode | undefined {
    const pending = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    return pending;
  }
  pending(now: number): PendingCode[] {
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
    return [...this.codes.values()].toSorted((a, b) => a.expiresAt - b.expiresAt);
  }
  remove(id: string): boolean {
    for (const [key, entry] of this.codes)
      if (entry.id === id) {
        this.codes.delete(key);
        return true;
      }
    return false;
  }
  clear(): void {
    this.codes.clear();
  }
}

const Row = z.object({
  id: z.string(),
  expires_at: z.number(),
  scopes: z.string().transform((text) => z.array(DeviceScope).parse(JSON.parse(text))),
  label: z.string().nullable(),
  device_ttl_ms: z.number().nullable(),
});
function decode(row: Record<string, SQLOutputValue>): PendingCode {
  const parsed = Row.parse(row);
  return {
    id: parsed.id,
    expiresAt: parsed.expires_at,
    scopes: parsed.scopes,
    ...(parsed.label === null ? {} : { label: parsed.label }),
    ...(parsed.device_ttl_ms === null ? {} : { deviceTtlMs: parsed.device_ttl_ms }),
  };
}

/**
 * Links kept in the daemon's database, so a restart (an update, a crash, a dev reload) doesn't
 * void a link someone is about to scan. Only the code's SHA-256 is stored, as device tokens are,
 * and a link still ends at its own expiry.
 */
export class SqlitePairingCodes implements PairingCodeStore {
  private readonly insert: StatementSync;
  private readonly taking: StatementSync;
  private readonly expired: StatementSync;
  private readonly listing: StatementSync;
  private readonly removing: StatementSync;
  private readonly clearing: StatementSync;
  constructor(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
      scopes TEXT NOT NULL, label TEXT, device_ttl_ms INTEGER
    )`);
    this.insert = db.prepare("INSERT INTO pairing_codes VALUES (?, ?, ?, ?, ?, ?)");
    this.taking = db.prepare("DELETE FROM pairing_codes WHERE code_hash = ? RETURNING *");
    this.expired = db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?");
    this.listing = db.prepare("SELECT * FROM pairing_codes ORDER BY expires_at, rowid");
    this.removing = db.prepare("DELETE FROM pairing_codes WHERE id = ?");
    this.clearing = db.prepare("DELETE FROM pairing_codes");
  }
  put(codeHash: string, pending: PendingCode): void {
    this.insert.run(
      codeHash,
      pending.id,
      pending.expiresAt,
      JSON.stringify(pending.scopes),
      pending.label ?? null,
      pending.deviceTtlMs ?? null,
    );
  }
  take(codeHash: string): PendingCode | undefined {
    const row = this.taking.get(codeHash);
    return row ? decode(row) : undefined;
  }
  pending(now: number): PendingCode[] {
    this.expired.run(now);
    return this.listing.all().map(decode);
  }
  remove(id: string): boolean {
    return this.removing.run(id).changes > 0;
  }
  clear(): void {
    this.clearing.run();
  }
}
