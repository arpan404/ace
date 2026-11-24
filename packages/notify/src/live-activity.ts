import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { DeviceId } from "@ace/protocol/ids";
import type { LiveActivitySync } from "@ace/protocol/notifications";

/**
 * The phone's two Live Activity tokens for this machine (ADR 0223): `start` starts an activity
 * by push, `liveactivity` updates or ends the activity this machine is showing.
 */
export const LiveActivityKind = z.enum(["start", "liveactivity"]);
export type LiveActivityKind = z.infer<typeof LiveActivityKind>;
export const LiveActivityEnvironment = z.enum(["sandbox", "production"]);
export type LiveActivityEnvironment = z.infer<typeof LiveActivityEnvironment>;
/** A token as the daemon registers it with the gateway; the gateway seals the handle's kind. */
export const LiveActivityTarget = z.object({
  token: z.string().min(16).max(400),
  environment: LiveActivityEnvironment,
  kind: LiveActivityKind,
  frequentUpdates: z.boolean(),
  /** The phone's number for this machine, 0 to 15. */
  slot: z.number().int().min(0).max(15),
  /**
   * The ids the daemon proved were one install when the phone synced this token (the syncing id
   * and at most `linkedLimit` others). The daemon checks each one's current pairing authority,
   * expiry and scopes before it registers a handle, so a pairing that lapsed while the daemon was
   * down cannot resume through the other route, while a separately authorized account alias can.
   */
  devices: z.array(DeviceId).min(1).max(17),
});
export type LiveActivityTarget = z.infer<typeof LiveActivityTarget>;
/**
 * One token per kind per device the store accepts: twice the device capacity. A store can never
 * hold more, so nothing that reads it — a reply, a gateway registration pass — grows with
 * anything but the phones paired to this machine.
 */
export const liveActivityLimit = 256;

/**
 * Additive and idempotent: an older database gains the table on open, and an older build ignores
 * it. One row per token: a device holds at most one of each kind, so the table stays smaller
 * than the device table, and opening it does no work that grows with stored history.
 */
export const liveActivityTables = `
  CREATE TABLE IF NOT EXISTS live_activity (
    kind TEXT NOT NULL, token TEXT NOT NULL, environment TEXT NOT NULL,
    frequent INTEGER NOT NULL, slot INTEGER NOT NULL, devices TEXT NOT NULL,
    PRIMARY KEY(kind,token,environment));`;

/**
 * A row this build wrote, decoded and not validated again (ADR 0125). The table's columns are
 * its own writes; only the association is read back through SQLite's JSON function.
 */
function stored(row: Record<string, unknown>): LiveActivityTarget {
  return {
    token: String(row.token),
    environment: row.environment as LiveActivityEnvironment,
    kind: row.kind as LiveActivityKind,
    frequentUpdates: Number(row.frequent) === 1,
    slot: Number(row.slot),
    devices: JSON.parse(String(row.devices)) as DeviceId[],
  };
}

/** APNs tokens are hex: one token reaches us in either case, and is kept in one. */
function normalize(address: Pick<LiveActivityTarget, "token">): string {
  return address.token.toLowerCase();
}

/**
 * The tokens a phone last reported for this machine, keyed by the tokens themselves so one that
 * arrives over both of an install's ids is stored once. `devices` is the association the daemon
 * proved is one install (ADR 0115): the newest sync of any of them replaces the whole set, and
 * clearing any one of them clears what they registered together.
 */
export class LiveActivityStore {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /** Authoritative: a missing token clears its kind, and a missing object clears both. */
  replace(devices: readonly DeviceId[], input: LiveActivitySync | undefined): void {
    for (const device of devices) this.forget(device);
    if (!input) return;
    const tokens: { kind: LiveActivityKind; token: string | undefined }[] = [
      { kind: "start", token: input.startToken },
      { kind: "liveactivity", token: input.activityToken },
    ];
    for (const { kind, token } of tokens) {
      if (token === undefined) continue;
      this.statement(
        `INSERT INTO live_activity(kind,token,environment,frequent,slot,devices) VALUES(?,?,?,?,?,?)
          ON CONFLICT(kind,token,environment) DO UPDATE SET frequent=excluded.frequent,
            slot=excluded.slot,devices=excluded.devices`,
      ).run(
        kind,
        normalize({ token }),
        input.environment,
        input.frequentUpdates ? 1 : 0,
        input.slot,
        JSON.stringify(devices),
      );
    }
  }
  /**
   * What this machine may push with. A row whose device is gone or revoked is not one: eviction
   * and revocation clear tokens, and this keeps a leftover from reaching the gateway meanwhile.
   * A device whose alert address expired (`expireAddress`) still counts: only its encrypted
   * alerts are gone; its Live Activity tokens are not.
   */
  targets(): LiveActivityTarget[] {
    return this.statement(
      `SELECT kind,token,environment,frequent,slot,devices FROM live_activity
        WHERE EXISTS (SELECT 1 FROM json_each(live_activity.devices)
          JOIN devices ON devices.id=json_each.value AND devices.revoked=0)
        ORDER BY slot,kind='liveactivity' LIMIT ${liveActivityLimit}`,
    )
      .all()
      .map(stored);
  }
  /** Live Activities are off, or pushes are: both tokens go. */
  clear(): void {
    this.statement("DELETE FROM live_activity").run();
  }
  /**
   * A gateway said this token is gone (ADR 0106). Only the token named goes: a token rotated
   * since is a different row and stays.
   */
  drop(address: Pick<LiveActivityTarget, "token" | "environment" | "kind">): void {
    this.statement("DELETE FROM live_activity WHERE kind=? AND token=? AND environment=?").run(
      address.kind,
      normalize(address),
      address.environment,
    );
  }
  /** An id of this install left: what it registered with the others goes too. */
  forget(device: DeviceId): void {
    this.statement(
      `DELETE FROM live_activity WHERE EXISTS
        (SELECT 1 FROM json_each(live_activity.devices) WHERE json_each.value=?)`,
    ).run(device);
  }
}
