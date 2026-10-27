import { z } from "zod";
import { MachineCapability, MachineGrantLevel, type MachineGrants } from "@ace/protocol";
import type { Store } from "../store.ts";

const Row = z.object({ device_id: z.string(), capability: z.string(), level: z.string() });

/** A capability lowered for a device: in-flight work it no longer allows stops (ADR 0105). */
export interface GrantChange {
  deviceId: string;
  capability: MachineCapability;
  level: MachineGrantLevel;
}

/**
 * The levels the person chose for each linked machine (`machine_grants`, ADR 0105). Only chosen
 * levels are stored; the rest follow the defaults in grant-rules.ts. Read on every call, so a
 * change applies to the next one.
 */
export class MachineGrantStore {
  private store: Store;
  private now: () => number;
  private listeners = new Set<(change: GrantChange) => void>();
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }
  /** The levels this device has of its own. Unknown rows (a newer build's) are skipped. */
  chosen(deviceId: string): Partial<MachineGrants> {
    const rows = this.store
      .statement("SELECT device_id,capability,level FROM machine_grants WHERE device_id=?")
      .all(deviceId);
    return this.decode(rows).get(deviceId) ?? {};
  }
  /** Every device that has a level of its own. */
  all(): Map<string, Partial<MachineGrants>> {
    const rows = this.store
      .statement("SELECT device_id,capability,level FROM machine_grants ORDER BY device_id")
      .all();
    return this.decode(rows);
  }
  set(deviceId: string, capability: MachineCapability, level: MachineGrantLevel): void {
    this.store.atomic(() =>
      this.store
        .statement(
          `INSERT INTO machine_grants (device_id,capability,level,updated_at) VALUES (?,?,?,?)
           ON CONFLICT(device_id,capability) DO UPDATE SET level=excluded.level,
           updated_at=excluded.updated_at`,
        )
        .run(deviceId, capability, level, this.now()),
    );
    for (const listener of this.listeners) listener({ deviceId, capability, level });
  }
  /** Hears every level the person sets, after it is stored. */
  onChange(listener: (change: GrantChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private decode(rows: unknown[]): Map<string, Partial<MachineGrants>> {
    const devices = new Map<string, Partial<MachineGrants>>();
    for (const value of rows) {
      const row = Row.parse(value);
      const capability = MachineCapability.safeParse(row.capability);
      const level = MachineGrantLevel.safeParse(row.level);
      if (!capability.success || !level.success) continue;
      const entry = devices.get(row.device_id) ?? {};
      entry[capability.data] = level.data;
      devices.set(row.device_id, entry);
    }
    return devices;
  }
}
