import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Profiles, RemoteProfile, directOf } from "../cli/profiles.ts";
import { connectionKey } from "./connections.ts";

/** How long a look may wait for another writer's lock on the file: it blocks the event loop. */
export const SAVED_PAIRINGS_BUSY_MS = 5;
/**
 * After a look finds the file unreadable, looks for this long answer "unreadable" at once
 * without touching SQLite. While a lock is held the event loop is blocked at most
 * SAVED_PAIRINGS_BUSY_MS per this window, however many calls are checked.
 */
export const SAVED_PAIRINGS_RETRY_MS = 250;

/**
 * The pairings saved now (`cli-profiles.sqlite`, written by Settings and by the `ace remote`
 * CLI in another process), read through one kept-open connection. Each look:
 * - `stat`s the path: a missing file means no pairings; a different file there (replaced, or
 *   deleted and made again) is opened afresh and read;
 * - asks SQLite for `PRAGMA data_version`, which moves whenever another connection commits to
 *   the open file, and reads and hashes the pairings again only then.
 * A look never throws. When the file can't be read (another writer's lock past
 * SAVED_PAIRINGS_BUSY_MS, a corrupt file, no permission) it says so: callers refuse what they
 * were asked to check and end nothing. Looks in the next SAVED_PAIRINGS_RETRY_MS say so at once;
 * the first after it tries again. A change between readable and unreadable is logged once, not
 * on every look.
 */
export class SavedPairings {
  private file: string;
  private log: (message: string, fields: Record<string, unknown>) => void;
  private db: DatabaseSync | undefined;
  /** The open file's device and inode. */
  private identity: string | undefined;
  private version: unknown = undefined;
  private profiles: RemoteProfile[] = [];
  private known: ReadonlySet<string> = new Set();
  /** Why the last look failed, until one succeeds. */
  private failing: string | undefined;
  /** Until this, looks answer "unreadable" without touching the file. */
  private retryAt = Number.NEGATIVE_INFINITY;
  private now: () => number;
  constructor(
    home: string,
    log: (message: string, fields: Record<string, unknown>) => void = () => {},
    now: () => number = () => performance.now(),
  ) {
    this.file = join(home, "cli-profiles.sqlite");
    this.log = log;
    this.now = now;
    try {
      // The table exists before it is read, as the CLI makes it.
      new Profiles(home).close();
    } catch (error) {
      this.failed(error);
    }
  }
  /** Every pairing saved now, or undefined when they can't be read just now. */
  list(): RemoteProfile[] | undefined {
    return this.refresh() ? this.profiles : undefined;
  }
  /** The connection keys (origin, pin and token) saved now, or undefined when unreadable. */
  keys(): ReadonlySet<string> | undefined {
    return this.refresh() ? this.known : undefined;
  }
  close(): void {
    this.closeDb();
  }
  private refresh(): boolean {
    if (this.failing !== undefined && this.now() < this.retryAt) return false;
    try {
      const stat = statSync(this.file, { throwIfNoEntry: false });
      if (!stat) {
        // No file, no pairings.
        if (this.identity !== "missing") {
          this.closeDb();
          this.set([]);
          this.identity = "missing";
        }
        return this.recovered();
      }
      const identity = `${stat.dev}:${stat.ino}`;
      if (!this.db || identity !== this.identity) {
        this.closeDb();
        const db = new DatabaseSync(this.file);
        db.exec(`PRAGMA busy_timeout = ${SAVED_PAIRINGS_BUSY_MS}`);
        this.db = db;
        this.identity = identity;
        this.version = undefined;
      }
      const version = this.db.prepare("PRAGMA data_version").get()?.data_version;
      if (version !== this.version) {
        const table = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profiles'")
          .get();
        this.set(
          table
            ? this.db
                .prepare("SELECT value FROM profiles ORDER BY name")
                .all()
                .map((row) => RemoteProfile.parse(JSON.parse(String(row.value))))
            : [],
        );
        this.version = version;
      }
      return this.recovered();
    } catch (error) {
      this.failed(error);
      return false;
    }
  }
  private set(profiles: RemoteProfile[]) {
    this.profiles = profiles;
    this.known = new Set(
      profiles.flatMap((profile) => {
        const direct = directOf(profile);
        return direct ? [connectionKey(direct)] : [];
      }),
    );
  }
  private closeDb() {
    try {
      this.db?.close();
    } catch {
      // Already closed: nothing to release.
    }
    this.db = undefined;
    this.identity = undefined;
    this.version = undefined;
  }
  private failed(error: unknown) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    if (this.failing !== reason)
      this.log("Saved pairings can't be read; calls to paired machines wait", { reason });
    this.failing = reason;
    this.retryAt = this.now() + SAVED_PAIRINGS_RETRY_MS;
    // A later look opens the file afresh.
    this.closeDb();
  }
  private recovered(): true {
    if (this.failing !== undefined) this.log("Saved pairings can be read again", {});
    this.failing = undefined;
    return true;
  }
}
