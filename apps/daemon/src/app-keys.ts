import type { DatabaseSync, StatementSync } from "node:sqlite";

/** What app keys need of the device records they are listed under (`devices.ts`). */
interface DeviceRecords {
  create(name: string, granted: ["desktop"], at: number): { device: { id: string } };
  revoke(id: string, at: number): boolean;
}

/** The device record a registered app key is listed and revoked under. */
export const appKeyDeviceName = "ace desktop app";

/**
 * The desktop app's public keys for this daemon, when the app didn't start it (ADR 0178 §12.8).
 * Each is listed as a `desktop` device record, so the person sees it among their devices and
 * revoking that record ends the key. Only the public half is stored: reading the database
 * proves nothing. One key at a time: registering one ends the last, so a key an agent slipped
 * in during a sign-in's ten minutes ends when the app registers its own, and the app sees its
 * own end if an agent's replaced it.
 */
export class AppKeys {
  private readonly db: DatabaseSync;
  private readonly devices: DeviceRecords;
  private statements:
    | { live: StatementSync; latest: StatementSync; insert: StatementSync }
    | undefined;
  constructor(db: DatabaseSync, devices: DeviceRecords) {
    this.db = db;
    this.devices = devices;
  }
  /** Prepared on first use, so a database that never meets the app needs no `app_keys`. */
  private get sql() {
    this.statements ??= {
      live: this.db.prepare(
        `SELECT app_keys.device_id, app_keys.public_key FROM app_keys JOIN devices ON devices.id = app_keys.device_id
         WHERE devices.revoked_at IS NULL ORDER BY app_keys.auth_at DESC`,
      ),
      latest: this.db.prepare("SELECT MAX(auth_at) AS auth_at FROM app_keys"),
      insert: this.db.prepare(
        "INSERT INTO app_keys (device_id, public_key, auth_at) VALUES (?, ?, ?)",
      ),
    };
    return this.statements;
  }

  /** The public keys whose signatures make a page the app's: at most one, unless revoked. */
  keys(): string[] {
    return this.sql.live.all().map((row) => String(row.public_key));
  }

  registered(publicKey: string): boolean {
    return this.keys().includes(publicKey);
  }

  /**
   * Register `publicKey` on the strength of a sign-in at `authAt` (the backend's clock). A
   * sign-in registers one key: false when this one, or a later one, already did.
   */
  register(publicKey: string, authAt: number, at: number): boolean {
    const spent = this.sql.latest.get()?.auth_at;
    if (typeof spent === "number" && authAt <= spent) return false;
    for (const row of this.sql.live.all()) this.devices.revoke(String(row.device_id), at);
    // The record's own token is never handed out: the app proves itself by signing.
    const { device } = this.devices.create(appKeyDeviceName, ["desktop"], at);
    this.sql.insert.run(device.id, publicKey, authAt);
    return true;
  }
}
