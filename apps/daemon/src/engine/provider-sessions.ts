import { z } from "zod";
import { NativeSessionId, ProviderKind, type ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/*
 * The native sessions a thread left behind when it moved to another provider. Returning to that
 * provider resumes its own session, which still holds everything up to `throughSeq`, so only what
 * happened since needs handing over (ADR 0051, 2026-10-19 amendment). Bounded per thread.
 */

const maxPerThread = 16;

export const LeftSession = z.object({
  provider: ProviderKind,
  instanceId: z.string().min(1).max(256).optional(),
  backend: z.string().min(1).max(256).optional(),
  nativeSessionId: NativeSessionId,
  /** The thread's event cutoff when the provider left: its native history covers up to here. */
  throughSeq: z.number().int().nonnegative(),
});
export type LeftSession = z.infer<typeof LeftSession>;

const Row = z.object({
  provider: ProviderKind,
  instance_id: z.string(),
  backend: z.string().nullable(),
  native_session_id: z.string(),
  through_seq: z.number().int().nonnegative(),
});

export class ProviderSessions {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_provider_sessions (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '',
        backend TEXT, native_session_id TEXT NOT NULL, through_seq INTEGER NOT NULL,
        PRIMARY KEY(thread_id, provider, instance_id)
      )`),
    );
  }

  /** The provider is leaving the thread with this session; a later return can resume it. */
  leave(id: ThreadId, left: LeftSession): void {
    const value = LeftSession.parse(left);
    this.store.atomic(() => {
      this.store
        .statement(
          `INSERT INTO engine_provider_sessions VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, provider, instance_id) DO UPDATE SET
            backend=excluded.backend, native_session_id=excluded.native_session_id,
            through_seq=excluded.through_seq`,
        )
        .run(
          id,
          value.provider,
          value.instanceId ?? "",
          value.backend ?? null,
          value.nativeSessionId,
          value.throughSeq,
        );
      this.store
        .statement(
          `DELETE FROM engine_provider_sessions WHERE thread_id=? AND rowid NOT IN (
            SELECT rowid FROM engine_provider_sessions WHERE thread_id=?
            ORDER BY through_seq DESC LIMIT ${maxPerThread})`,
        )
        .run(id, id);
    });
  }

  /**
   * The session `provider` left on this thread, for the account asked for: that exact account,
   * or with none named, the most recent one.
   */
  recall(id: ThreadId, provider: ProviderKind, instanceId?: string): LeftSession | undefined {
    return this.store.atomic(() => {
      const row = (
        instanceId === undefined
          ? this.store
              .statement(
                "SELECT * FROM engine_provider_sessions WHERE thread_id=? AND provider=? ORDER BY through_seq DESC LIMIT 1",
              )
              .get(id, provider)
          : this.store
              .statement(
                "SELECT * FROM engine_provider_sessions WHERE thread_id=? AND provider=? AND instance_id=?",
              )
              .get(id, provider, instanceId)
      ) as unknown;
      const parsed = Row.safeParse(row);
      if (!parsed.success) return undefined;
      const value = parsed.data;
      return LeftSession.parse({
        provider: value.provider,
        ...(value.instance_id ? { instanceId: value.instance_id } : {}),
        ...(value.backend ? { backend: value.backend } : {}),
        nativeSessionId: value.native_session_id,
        throughSeq: value.through_seq,
      });
    });
  }

  /** The session can't be resumed (the provider lost it): never offer it again. */
  forget(id: ThreadId, provider: ProviderKind, nativeSessionId: string): void {
    this.store.atomic(() =>
      this.store
        .statement(
          "DELETE FROM engine_provider_sessions WHERE thread_id=? AND provider=? AND native_session_id=?",
        )
        .run(id, provider, nativeSessionId),
    );
  }
}
