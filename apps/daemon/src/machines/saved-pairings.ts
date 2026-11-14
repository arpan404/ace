import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Profiles, RemoteProfile } from "../cli/profiles.ts";
import { connectionKey } from "./connections.ts";

/**
 * The pairings saved now (`cli-profiles.sqlite`, written by Settings and by the `ace remote`
 * CLI in another process), read through one kept-open connection. Each look asks SQLite for
 * `PRAGMA data_version`, which moves whenever another connection commits to the file, and reads
 * and hashes the pairings again only then, so checking a pairing is still saved costs one pragma.
 */
export class SavedPairings {
  private db: DatabaseSync;
  private version: unknown = undefined;
  private profiles: RemoteProfile[] = [];
  private known = new Set<string>();
  constructor(home: string) {
    // The table exists before it is read, as the CLI makes it.
    new Profiles(home).close();
    this.db = new DatabaseSync(join(home, "cli-profiles.sqlite"));
  }
  /** Every pairing saved now. */
  list(): RemoteProfile[] {
    this.refresh();
    return this.profiles;
  }
  /** The connection keys (origin, pin and token) of the pairings saved now. */
  keys(): ReadonlySet<string> {
    this.refresh();
    return this.known;
  }
  close(): void {
    this.db.close();
  }
  private refresh() {
    const version = this.db.prepare("PRAGMA data_version").get()?.data_version;
    if (version === this.version) return;
    this.version = version;
    this.profiles = this.db
      .prepare("SELECT value FROM profiles ORDER BY name")
      .all()
      .map((row) => RemoteProfile.parse(JSON.parse(String(row.value))));
    this.known = new Set(this.profiles.map(connectionKey));
  }
}
