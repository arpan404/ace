import { z } from "zod";
import { DatabaseSync } from "./sqlite.ts";
import { processIdentity, processGroupIsGone, type ProcessIdentity } from "./process-identity.ts";
export interface ProcessJournal {
  add(pid: number, metadata: { name: string; cwd?: string }): void;
  remove(pid: number): void;
}
const Entry = z.object({
  pid: z.number().int().positive(),
  start: z.string(),
  uid: z.number().int().nonnegative(),
  group: z.number().int().positive(),
  ownerPid: z.number().int().positive(),
  ownerStart: z.string(),
  name: z.string().max(256),
  cwd: z.string().optional(),
  createdAt: z.number(),
});
export type ProcessEntry = z.infer<typeof Entry>;
export interface InventoryRuntime {
  identity(pid: number): ProcessIdentity | undefined;
  alive(group: number): boolean;
  kill(group: number): void;
  ownerPid: number;
  now(): number;
}
export const inventoryRuntime: InventoryRuntime = {
  identity: processIdentity,
  ownerPid: process.pid,
  now: Date.now,
  alive(group) {
    return !processGroupIsGone(group);
  },
  kill(group) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
    }
  },
};
/** Only kernel identities and non-secret labels persist; provider input never enters this journal. */
export class ProcessInventory implements ProcessJournal {
  private db: DatabaseSync;
  private runtime: InventoryRuntime;
  constructor(path: string, runtime: InventoryRuntime = inventoryRuntime) {
    this.runtime = runtime;
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS processes(pid INTEGER PRIMARY KEY,entry TEXT NOT NULL)",
    );
  }
  list(): ProcessEntry[] {
    return this.db
      .prepare("SELECT entry FROM processes ORDER BY pid")
      .all()
      .map((row) => Entry.parse(JSON.parse(String(row.entry))));
  }
  add(pid: number, metadata: { name: string; cwd?: string }): void {
    const identity = this.runtime.identity(pid);
    const owner = this.runtime.identity(this.runtime.ownerPid);
    if (!identity && !this.runtime.alive(pid)) return;
    if (
      !identity ||
      !owner ||
      identity.pid !== pid ||
      owner.pid !== this.runtime.ownerPid ||
      identity.group !== pid ||
      identity.uid !== owner.uid
    )
      throw new Error("Cannot record owned process identity");
    if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n) >= 4096)
      throw new Error("Process inventory capacity");
    const entry = Entry.parse({
      ...identity,
      ownerPid: this.runtime.ownerPid,
      ownerStart: owner.start,
      name: metadata.name,
      cwd: metadata.cwd,
      createdAt: this.runtime.now(),
    });
    this.db
      .prepare(
        "INSERT INTO processes VALUES (?,?) ON CONFLICT(pid) DO UPDATE SET entry=excluded.entry",
      )
      .run(pid, JSON.stringify(entry));
  }
  remove(pid: number): void {
    this.db.prepare("DELETE FROM processes WHERE pid=?").run(pid);
  }
  recover(): { removed: number; killed: number } {
    let removed = 0;
    let killed = 0;
    for (const entry of this.list()) {
      const owner = this.runtime.identity(entry.ownerPid);
      if (
        owner?.pid === entry.ownerPid &&
        owner.start === entry.ownerStart &&
        owner.uid === entry.uid
      )
        continue;
      const current = this.runtime.identity(entry.pid);
      if (!this.runtime.alive(entry.group)) {
        this.remove(entry.pid);
        removed++;
        continue;
      }
      if (
        !current ||
        current.pid !== entry.pid ||
        current.start !== entry.start ||
        current.uid !== entry.uid ||
        current.group !== entry.group
      )
        throw new Error(`Orphan group ${entry.group} cannot be safely identified`);
      this.runtime.kill(entry.group);
      // Keep evidence until a later recovery proves the group has disappeared.
      killed++;
    }
    return { removed, killed };
  }
  close(): void {
    this.db.close();
  }
}
