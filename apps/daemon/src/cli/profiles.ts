import { z } from "zod";
import { DeviceId, DeviceToken } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { secureDataDir } from "../local-files.ts";
const name = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
  .refine((value) => value !== "local");
export const RemoteProfile = z.object({
  id: z.uuid(),
  name,
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deviceId: DeviceId,
  token: DeviceToken,
});
export type RemoteProfile = z.infer<typeof RemoteProfile>;
export class Profiles {
  private db: DatabaseSync;
  private id: () => string;
  constructor(home: string, id: () => string = randomUUID) {
    secureDataDir(home);
    this.id = id;
    this.db = new DatabaseSync(join(home, "cli-profiles.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS profiles(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS selection(id INTEGER PRIMARY KEY,name TEXT)",
    );
  }
  list(): RemoteProfile[] {
    return this.db
      .prepare("SELECT value FROM profiles ORDER BY name")
      .all()
      .map((row) => RemoteProfile.parse(JSON.parse(String(row.value))));
  }
  selected(): string | null {
    const row = this.db.prepare("SELECT name FROM selection WHERE id=1").get();
    return row?.name === undefined || row.name === null ? null : name.parse(row.name);
  }
  get(selected: string): RemoteProfile {
    const row = this.db
      .prepare("SELECT value FROM profiles WHERE name=?")
      .get(name.parse(selected));
    if (!row) throw new Error(`Unknown remote profile ${selected}`);
    return RemoteProfile.parse(JSON.parse(String(row.value)));
  }
  add(input: Omit<RemoteProfile, "id">): RemoteProfile {
    if (this.list().length >= 64) throw new Error("Remote profile capacity");
    const value = RemoteProfile.parse({ ...input, id: this.id() });
    this.db.prepare("INSERT INTO profiles VALUES (?,?)").run(value.name, JSON.stringify(value));
    return value;
  }
  use(selected: string): void {
    if (selected !== "local") this.get(selected);
    this.db
      .prepare(
        "INSERT INTO selection VALUES (1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
      )
      .run(selected === "local" ? null : selected);
  }
  remove(selected: string): void {
    this.get(selected);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM profiles WHERE name=?").run(selected);
      this.db.prepare("UPDATE selection SET name=NULL WHERE name=?").run(selected);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
export function profileSummary(profile: RemoteProfile) {
  const { token: _token, ...summary } = profile;
  return summary;
}
export function selectedProfile(home: string, selected?: string): RemoteProfile | undefined {
  const profiles = new Profiles(home);
  try {
    const target = selected ?? profiles.selected();
    return target && target !== "local" ? profiles.get(target) : undefined;
  } finally {
    profiles.close();
  }
}
