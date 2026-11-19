import type { EnrolledPins } from "../machines/link-routes.ts";
import type { MachinePath, ParcelFacts } from "@ace/protocol";
import type { Store } from "../store.ts";

/**
 * Durable parcel rows (ADR 0182). Both tables are new and made on first use, so opening the
 * daemon never waits on them. Rows are written only by this build; reading them back trusts
 * their shape (ADR 0125).
 */

/** How an outgoing parcel travels: to a thread here, pushed to a child there, or pulled back. */
export type OutRoute = "local" | "push" | "outbox";
export type OutState = "sending" | "waiting" | "delivered" | "failed" | "cancelled";
export const unsettledOut: readonly OutState[] = ["sending", "waiting"];

export interface OutRow {
  parcelId: string;
  fromThread: string;
  fromAgent: string;
  toThread: string;
  route: OutRoute;
  /** push: the machine's profile name and host id there. */
  machine?: string | undefined;
  hostId?: string | undefined;
  /** outbox: the paired device and machine allowed to pull it. */
  deviceId?: string | undefined;
  originHost?: string | undefined;
  facts: ParcelFacts;
  state: OutState;
  /** push: the bytes the receiver said it holds. */
  held: number;
  attempts: number;
  nextAt: number;
  error?: string | undefined;
  createdAt: number;
  updatedAt: number;
  /** The settled result was handed to the sending thread. */
  delivered: boolean;
}

export type InSource = "local" | "push" | "pull";
export type InState = "receiving" | "delivered" | "cancelled";

export interface InRow {
  parcelId: string;
  toThread: string;
  fromThread: string;
  /** The sending machine's name; absent when it was sent here. */
  fromMachine?: string | undefined;
  source: InSource;
  /** push: the device that sent it; pull: the profile it was pulled from. */
  deviceId?: string | undefined;
  originHost?: string | undefined;
  facts: ParcelFacts;
  state: InState;
  held: number;
  createdAt: number;
  updatedAt: number;
  /** The receiving thread was told it arrived. */
  notified: boolean;
}

type Raw = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => Number(value ?? 0);

function outRow(raw: Raw): OutRow {
  return {
    parcelId: String(raw["parcel_id"]),
    fromThread: String(raw["from_thread"]),
    fromAgent: String(raw["from_agent"]),
    toThread: String(raw["to_thread"]),
    route: String(raw["route"]) as OutRoute,
    machine: text(raw["machine"]),
    hostId: text(raw["host_id"]),
    deviceId: text(raw["device_id"]),
    originHost: text(raw["origin_host"]),
    facts: JSON.parse(String(raw["facts"])) as ParcelFacts,
    state: String(raw["state"]) as OutState,
    held: num(raw["held"]),
    attempts: num(raw["attempts"]),
    nextAt: num(raw["next_at"]),
    error: text(raw["error"]),
    createdAt: num(raw["created_at"]),
    updatedAt: num(raw["updated_at"]),
    delivered: num(raw["delivered"]) === 1,
  };
}

function inRow(raw: Raw): InRow {
  return {
    parcelId: String(raw["parcel_id"]),
    toThread: String(raw["to_thread"]),
    fromThread: String(raw["from_thread"]),
    fromMachine: text(raw["from_machine"]),
    source: String(raw["source"]) as InSource,
    deviceId: text(raw["device_id"]),
    originHost: text(raw["origin_host"]),
    facts: JSON.parse(String(raw["facts"])) as ParcelFacts,
    state: String(raw["state"]) as InState,
    held: num(raw["held"]),
    createdAt: num(raw["created_at"]),
    updatedAt: num(raw["updated_at"]),
    notified: num(raw["notified"]) === 1,
  };
}

export class ParcelRows {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS parcel_out (
        parcel_id TEXT PRIMARY KEY, from_thread TEXT NOT NULL, from_agent TEXT NOT NULL,
        to_thread TEXT NOT NULL, route TEXT NOT NULL, machine TEXT, host_id TEXT, device_id TEXT,
        origin_host TEXT, facts TEXT NOT NULL, state TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS parcel_out_state ON parcel_out(state, next_at);
      CREATE INDEX IF NOT EXISTS parcel_out_thread ON parcel_out(from_thread, created_at);
      CREATE INDEX IF NOT EXISTS parcel_out_pull ON parcel_out(device_id, origin_host, state);
      CREATE TABLE IF NOT EXISTS parcel_in (
        parcel_id TEXT PRIMARY KEY, to_thread TEXT NOT NULL, from_thread TEXT NOT NULL,
        from_machine TEXT, source TEXT NOT NULL, device_id TEXT, origin_host TEXT,
        facts TEXT NOT NULL, state TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS parcel_in_thread ON parcel_in(to_thread, created_at);
      CREATE INDEX IF NOT EXISTS parcel_in_state ON parcel_in(state, updated_at);
      CREATE TABLE IF NOT EXISTS parcel_paths (
        profile_id TEXT PRIMARY KEY, paths TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS parcel_pins (
        profile_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, tls TEXT, relay TEXT,
        updated_at INTEGER NOT NULL);`),
    );
  }
  insertOut(row: OutRow): void {
    this.store
      .statement(
        `INSERT INTO parcel_out (parcel_id,from_thread,from_agent,to_thread,route,machine,host_id,
          device_id,origin_host,facts,state,held,attempts,next_at,error,created_at,updated_at,delivered)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.parcelId,
        row.fromThread,
        row.fromAgent,
        row.toThread,
        row.route,
        row.machine ?? null,
        row.hostId ?? null,
        row.deviceId ?? null,
        row.originHost ?? null,
        JSON.stringify(row.facts),
        row.state,
        row.held,
        row.attempts,
        row.nextAt,
        row.error ?? null,
        row.createdAt,
        row.updatedAt,
        row.delivered ? 1 : 0,
      );
  }
  out(parcelId: string): OutRow | undefined {
    const raw = this.store.statement("SELECT * FROM parcel_out WHERE parcel_id=?").get(parcelId);
    return raw ? outRow(raw) : undefined;
  }
  /** Pushes due now, the longest waiting first. */
  duePushes(now: number, limit = 16): OutRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_out WHERE route='push' AND state='sending' AND next_at <= ? ORDER BY next_at LIMIT ?",
      )
      .all(now, limit)
      .map(outRow);
  }
  /** When the next push waiting out a retry is due, if any is. */
  nextPushAt(now: number): number | undefined {
    const row = this.store
      .statement(
        "SELECT MIN(next_at) AS at FROM parcel_out WHERE route='push' AND state='sending' AND next_at > ?",
      )
      .get(now);
    return row?.["at"] === null || row?.["at"] === undefined ? undefined : num(row["at"]);
  }
  /** Copies to threads here still unsettled: a restart cut them off. */
  unsettledLocal(limit = 64): OutRow[] {
    return this.store
      .statement("SELECT * FROM parcel_out WHERE route='local' AND state='sending' LIMIT ?")
      .all(limit)
      .map(outRow);
  }
  /** Settled outgoing parcels whose thread hasn't been told yet. */
  undeliveredOut(limit = 64): OutRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_out WHERE state IN ('delivered','failed','cancelled') AND delivered=0 ORDER BY updated_at LIMIT ?",
      )
      .all(limit)
      .map(outRow);
  }
  /** Parcels waiting here for `device` on `originHost` to pull them. */
  outbox(deviceId: string, originHost: string, limit = 16): OutRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_out WHERE route='outbox' AND state='waiting' AND device_id=? AND origin_host=? ORDER BY created_at LIMIT ?",
      )
      .all(deviceId, originHost, limit)
      .map(outRow);
  }
  updateOut(
    parcelId: string,
    change: Partial<Pick<OutRow, "state" | "held" | "attempts" | "nextAt" | "error">>,
    now: number,
  ): void {
    const current = this.out(parcelId);
    if (!current) return;
    const next = { ...current, ...change };
    this.store
      .statement(
        "UPDATE parcel_out SET state=?,held=?,attempts=?,next_at=?,error=?,updated_at=? WHERE parcel_id=?",
      )
      .run(next.state, next.held, next.attempts, next.nextAt, next.error ?? null, now, parcelId);
  }
  /** Settles an unsettled parcel; false when it had settled already (a cancel raced it). */
  settleOut(
    parcelId: string,
    state: "delivered" | "failed" | "cancelled",
    now: number,
    error?: string,
  ): boolean {
    const changed = this.store
      .statement(
        "UPDATE parcel_out SET state=?,error=?,updated_at=? WHERE parcel_id=? AND state IN ('sending','waiting')",
      )
      .run(state, error ?? null, now, parcelId);
    return Number(changed.changes) === 1;
  }
  markOutDelivered(parcelId: string): void {
    this.store.statement("UPDATE parcel_out SET delivered=1 WHERE parcel_id=?").run(parcelId);
  }
  insertIn(row: InRow): void {
    this.store
      .statement(
        `INSERT OR IGNORE INTO parcel_in (parcel_id,to_thread,from_thread,from_machine,source,device_id,
          origin_host,facts,state,held,created_at,updated_at,notified) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.parcelId,
        row.toThread,
        row.fromThread,
        row.fromMachine ?? null,
        row.source,
        row.deviceId ?? null,
        row.originHost ?? null,
        JSON.stringify(row.facts),
        row.state,
        row.held,
        row.createdAt,
        row.updatedAt,
        row.notified ? 1 : 0,
      );
  }
  in(parcelId: string): InRow | undefined {
    const raw = this.store.statement("SELECT * FROM parcel_in WHERE parcel_id=?").get(parcelId);
    return raw ? inRow(raw) : undefined;
  }
  updateIn(
    parcelId: string,
    change: Partial<Pick<InRow, "state" | "held" | "notified">>,
    now: number,
  ): void {
    const current = this.in(parcelId);
    if (!current) return;
    const next = { ...current, ...change };
    this.store
      .statement("UPDATE parcel_in SET state=?,held=?,notified=?,updated_at=? WHERE parcel_id=?")
      .run(next.state, next.held, next.notified ? 1 : 0, now, parcelId);
  }
  removeIn(parcelId: string): void {
    this.store.statement("DELETE FROM parcel_in WHERE parcel_id=?").run(parcelId);
  }
  /** Parcels still arriving with no progress since before `before`: abandoned by their sender. */
  staleReceiving(before: number, limit = 32): InRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_in WHERE state='receiving' AND updated_at < ? ORDER BY updated_at LIMIT ?",
      )
      .all(before, limit)
      .map(inRow);
  }
  /** Delivered parcels whose thread hasn't been told yet. */
  unnotifiedIn(limit = 64): InRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_in WHERE state='delivered' AND notified=0 ORDER BY updated_at LIMIT ?",
      )
      .all(limit)
      .map(inRow);
  }
  /** One thread's parcels, sent and received, newest first. */
  forThread(threadId: string, limit = 32): { sent: OutRow[]; received: InRow[] } {
    return {
      sent: this.store
        .statement("SELECT * FROM parcel_out WHERE from_thread=? ORDER BY created_at DESC LIMIT ?")
        .all(threadId, limit)
        .map(outRow),
      received: this.store
        .statement("SELECT * FROM parcel_in WHERE to_thread=? ORDER BY created_at DESC LIMIT ?")
        .all(threadId, limit)
        .map(inRow),
    };
  }
  /** Bytes held or staged by parcels not yet expired, for the quota. */
  heldBytes(): number {
    const row = this.store
      .statement(
        `SELECT (SELECT COALESCE(SUM(json_extract(facts,'$.size')),0) FROM parcel_out WHERE state IN ('sending','waiting'))
          + (SELECT COALESCE(SUM(CASE state WHEN 'delivered' THEN json_extract(facts,'$.size') ELSE held END),0) FROM parcel_in WHERE state IN ('receiving','delivered')) AS n`,
      )
      .get();
    return num(row?.["n"]);
  }
  /** The paths a linked machine last said it serves, as this build parsed and wrote them. */
  paths(profileId: string): { paths: MachinePath[]; updatedAt: number } | undefined {
    const raw = this.store
      .statement("SELECT paths,updated_at FROM parcel_paths WHERE profile_id=?")
      .get(profileId);
    return raw
      ? {
          paths: JSON.parse(String(raw["paths"])) as MachinePath[],
          updatedAt: num(raw["updated_at"]),
        }
      : undefined;
  }
  savePaths(profileId: string, paths: readonly MachinePath[], now: number): void {
    this.store
      .statement("INSERT OR REPLACE INTO parcel_paths VALUES (?,?,?)")
      .run(profileId, JSON.stringify(paths.slice(0, 16)), now);
  }
  /**
   * The keys a pairing enrolled after it was made (ADR 0192). A row from an earlier pairing under
   * the same profile (another device there) counts for nothing: linking again starts over.
   */
  pins(profileId: string, deviceId: string): EnrolledPins {
    const raw = this.store
      .statement("SELECT device_id,tls,relay FROM parcel_pins WHERE profile_id=?")
      .get(profileId);
    if (!raw || String(raw["device_id"]) !== deviceId) return {};
    const tls = text(raw["tls"]);
    const relay = text(raw["relay"]);
    return { ...(tls ? { tls } : {}), ...(relay ? { relay } : {}) };
  }
  savePins(profileId: string, deviceId: string, pins: EnrolledPins, now: number): void {
    this.store
      .statement("INSERT OR REPLACE INTO parcel_pins VALUES (?,?,?,?,?)")
      .run(profileId, deviceId, pins.tls ?? null, pins.relay ?? null, now);
  }
  /** Parcels waiting for a parent to pull them since before `before`, for the deadline. */
  staleOutbox(before: number, limit = 32): OutRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_out WHERE route='outbox' AND state='waiting' AND created_at < ? ORDER BY created_at LIMIT ?",
      )
      .all(before, limit)
      .map(outRow);
  }
  /** At most `limit` received parcels last changed before `before`, for retention. */
  expiredIn(before: number, limit = 32): InRow[] {
    return this.store
      .statement(
        "SELECT * FROM parcel_in WHERE state IN ('receiving','delivered') AND updated_at < ? ORDER BY updated_at LIMIT ?",
      )
      .all(before, limit)
      .map(inRow);
  }
}
