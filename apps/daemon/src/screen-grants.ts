import { z } from "zod";
import { ScreenBundle, ScreenGrant, ThreadId, type ScreenAgentScope } from "@ace/protocol";
import type { Store } from "./store.ts";

import { browserApp, sensitiveApp } from "@ace/screen/sensitive-app";
export { sensitiveApp } from "@ace/screen/sensitive-app";
/** SQLite decisions, without retaining the event history or opening the native helper. */
export class ScreenGrants {
  constructor(
    privateStore: Store,
    privateNow: () => number,
    turn: (threadId: string) => string | undefined,
    changed: () => void = () => {},
  ) {
    this.changed = changed;
    this.store = privateStore;
    this.now = privateNow;
    this.turn = turn;
    this.store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS screen_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO screen_settings VALUES (1,0);
        CREATE TABLE IF NOT EXISTS screen_grants (bundle_id TEXT NOT NULL, scope TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', turn_id TEXT NOT NULL DEFAULT '', granted_at REAL NOT NULL, PRIMARY KEY(bundle_id,scope,thread_id));
        DELETE FROM screen_grants WHERE scope='turn';`);
    });
  }
  private readonly changed: () => void;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly turn: (threadId: string) => string | undefined;
  enabled(): boolean {
    return (
      z
        .object({ enabled: z.number() })
        .parse(
          this.store.atomic((db) =>
            db.prepare("SELECT enabled FROM screen_settings WHERE id=1").get(),
          ),
        ).enabled === 1
    );
  }
  enable(enabled: boolean) {
    this.store.atomic((db) =>
      db.prepare("UPDATE screen_settings SET enabled=? WHERE id=1").run(enabled ? 1 : 0),
    );
    this.changed();
  }
  list(threadId?: string): ScreenGrant[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT bundle_id AS bundleId, scope, nullif(thread_id,'') AS threadId, nullif(turn_id,'') AS turnId, granted_at AS grantedAt FROM screen_grants WHERE (? IS NULL OR thread_id='' OR thread_id=?) ORDER BY bundle_id LIMIT 1024",
          )
          .all(threadId ?? null, threadId ?? ""),
      )
      .map((raw) => {
        const row = z
          .object({
            bundleId: ScreenBundle,
            scope: ScreenGrant.shape.scope,
            threadId: z.string().nullable(),
            turnId: z.string().nullable(),
            grantedAt: z.number(),
          })
          .parse(raw);
        return ScreenGrant.parse({
          ...row,
          threadId: row.threadId ?? undefined,
          turnId: row.turnId ?? undefined,
        });
      })
      .filter(
        (grant) =>
          grant.scope !== "turn" || (grant.threadId && grant.turnId === this.turn(grant.threadId)),
      );
  }
  currentTurn(threadId: string) {
    return this.turn(threadId);
  }
  allows(bundleId: string, scope?: ScreenAgentScope): boolean {
    if (
      scope &&
      !this.store.atomic((db) =>
        db
          .prepare(
            "SELECT 1 FROM threads WHERE id=? AND json_extract(client,'$.deletedAt') IS NULL",
          )
          .get(ThreadId.parse(scope.threadId)),
      )
    )
      return false;
    const rows = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT scope,thread_id,turn_id FROM screen_grants WHERE bundle_id=? AND (thread_id='' OR thread_id=?)",
        )
        .all(ScreenBundle.parse(bundleId), scope?.threadId ?? ""),
    );
    const grants = rows.map((raw) =>
      z
        .object({ scope: ScreenGrant.shape.scope, thread_id: z.string(), turn_id: z.string() })
        .parse(raw),
    );
    const turn = scope ? this.turn(scope.threadId) : undefined;
    const turnGrant = grants.some(
      (grant) =>
        grant.scope === "turn" && grant.thread_id === scope?.threadId && grant.turn_id === turn,
    );
    if (scope && sensitiveApp(bundleId)) return turnGrant;
    return (
      turnGrant ||
      grants.some(
        (grant) =>
          (grant.scope === "always" && !browserApp(bundleId)) ||
          (scope && grant.scope === "thread" && grant.thread_id === scope.threadId),
      )
    );
  }
  allowlist(scope?: ScreenAgentScope): string[] {
    return [...new Set(this.list(scope?.threadId).map((grant) => grant.bundleId))].filter(
      (bundle) => this.allows(bundle, scope),
    );
  }
  approve(
    bundleId: string,
    allowed: boolean,
    scope: ScreenGrant["scope"],
    threadId?: string,
  ): void {
    const bundle = ScreenBundle.parse(bundleId);
    if (allowed && scope === "always" && browserApp(bundle))
      throw new Error("Web browsers require a turn or thread grant from the person in ace's UI");
    if (!allowed) {
      this.store.atomic((db) =>
        db
          .prepare("DELETE FROM screen_grants WHERE bundle_id=? AND scope=? AND thread_id=?")
          .run(bundle, scope, scope === "always" ? "" : ThreadId.parse(threadId)),
      );
      this.changed();
      return;
    }
    const thread = scope === "always" ? "" : ThreadId.parse(threadId);
    if (thread && !this.store.getThread(ThreadId.parse(thread)))
      throw new Error("Screen approval thread unavailable");
    const turn = scope === "turn" ? this.turn(thread) : "";
    if (turn === undefined) throw new Error("Screen turn approval requires an active root turn");
    this.store.atomic((db) => {
      const count = z
        .object({ count: z.number() })
        .parse(db.prepare("SELECT count(*) AS count FROM screen_grants").get()).count;
      if (
        count >= 1024 &&
        !db
          .prepare("SELECT 1 FROM screen_grants WHERE bundle_id=? AND scope=? AND thread_id=?")
          .get(bundle, scope, thread)
      )
        throw new Error("Screen approval limit; revoke a grant first");
      db.prepare(
        "INSERT INTO screen_grants VALUES (?,?,?,?,?) ON CONFLICT(bundle_id,scope,thread_id) DO UPDATE SET turn_id=excluded.turn_id,granted_at=excluded.granted_at",
      ).run(bundle, scope, thread, turn, this.now());
    });
    this.changed();
  }
}
