import { z } from "zod";
import { AceMachine } from "@ace/protocol/ace-account";

const Row = z.object({
  host_id: z.string(),
  name: z.string(),
  platform: z.string(),
  last_seen_at: z.number(),
});

/** The machine directory: which account each proven host id belongs to. */
export function machineStore(db: D1Database) {
  return {
    /** A machine signing in to another account moves to it. */
    async register(
      machine: { hostId: string; accountId: string; name: string; platform: string },
      now: number,
    ) {
      await db
        .prepare(
          `INSERT INTO machines (host_id, account_id, name, platform, created_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT (host_id) DO UPDATE SET
             account_id = excluded.account_id, name = excluded.name,
             platform = excluded.platform, last_seen_at = excluded.last_seen_at`,
        )
        .bind(machine.hostId, machine.accountId, machine.name, machine.platform, now)
        .run();
    },
    async seen(hostId: string, accountId: string, now: number) {
      await db
        .prepare("UPDATE machines SET last_seen_at = ? WHERE host_id = ? AND account_id = ?")
        .bind(now, hostId, accountId)
        .run();
    },
    async list(accountId: string): Promise<AceMachine[]> {
      const { results } = await db
        .prepare(
          "SELECT host_id, name, platform, last_seen_at FROM machines WHERE account_id = ? ORDER BY last_seen_at DESC LIMIT 1000",
        )
        .bind(accountId)
        .all();
      return results.map((raw) => {
        const row = Row.parse(raw);
        return AceMachine.parse({
          hostId: row.host_id,
          name: row.name,
          platform: row.platform,
          lastSeenAt: row.last_seen_at,
        });
      });
    },
    /** Forgets a machine on this account only. False when it isn't there. */
    async forget(hostId: string, accountId: string): Promise<boolean> {
      const result = await db
        .prepare("DELETE FROM machines WHERE host_id = ? AND account_id = ?")
        .bind(hostId, accountId)
        .run();
      return result.meta.changes > 0;
    },
  };
}
