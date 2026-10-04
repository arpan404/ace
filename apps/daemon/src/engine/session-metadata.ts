import { z } from "zod";
import { ExecutionOptions, type ThreadId } from "@ace/protocol";
import type { ProviderBackend } from "@ace/engine-api";
import type { EngineRepository } from "./repository.ts";
/** Persisted provider/account/workspace binding, shared by preparation and recovery. */
export class SessionMetadata {
  private repo: EngineRepository;
  constructor(repo: EngineRepository) { this.repo = repo; }
  session(id: ThreadId): {
    cwd: string;
    model?: string;
    nativeSessionId?: string;
    backend?: ProviderBackend;
    instanceId?: string;
    workspaceReady: boolean;
    options?: ExecutionOptions;
  } {
    return this.repo.store.atomic((_db) => {
      const row = this.repo.store.statement("SELECT * FROM engine_sessions WHERE thread_id = ?").get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return {
        cwd: String(row.cwd),
        ...(row.backend == null
          ? {}
          : { backend: z.enum(["acp", "cursor-sdk"]).parse(row.backend) }),
        ...(row.instance_id == null
          ? {}
          : { instanceId: z.string().min(1).max(256).parse(row.instance_id) }),
        workspaceReady: row.workspace_ready === 1,
        ...(row.options == null
          ? {}
          : { options: ExecutionOptions.parse(JSON.parse(String(row.options))) }),
        ...(row.model === null ? {} : { model: String(row.model) }),
        ...(row.native_session_id === null
          ? {}
          : { nativeSessionId: String(row.native_session_id) }),
      };
    });
  }
  createUnpreparedSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.createSession(id, cwd, model, backend, instanceId, options);
    this.repo.store.atomic((_db) =>
      this.repo.store
        .statement("UPDATE engine_sessions SET workspace_ready=0 WHERE thread_id=?")
        .run(id),
    );
  }
  createSession(
    id: ThreadId,
    cwd: string,
    model?: string,
    backend?: ProviderBackend,
    instanceId?: string,
    options?: ExecutionOptions,
  ): void {
    this.repo.store.atomic((_db) =>
      this.repo.store
        .statement(
          "INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        )
        .run(
          id,
          cwd,
          model ?? null,
          backend ?? null,
          instanceId ?? null,
          options ? JSON.stringify(options) : null,
        ),
    );
  }
  nativeSession(
    id: ThreadId,
    nativeId: string,
    backend?: ProviderBackend,
    instanceId?: string,
  ): void {
    this.repo.store.atomic((_db) => {
      this.repo.store
        .statement(
          "UPDATE engine_sessions SET native_session_id = ?, backend = COALESCE(?,backend), instance_id = COALESCE(?,instance_id) WHERE thread_id = ?",
        )
        .run(nativeId, backend ?? null, instanceId ?? null, id);
      const thread = this.repo.store.getThread(id);
      if (thread && instanceId && thread.live?.account !== instanceId)
        this.repo.store.appendEvents(id, [
          {
            type: "thread.client.updated",
            changes: { live: { ...thread.live, account: instanceId } },
          },
        ]);
    });
  }
  pinSessionIdentity(
    id: ThreadId,
    identity: {
      backend: ProviderBackend;
      instanceId: string;
      nativeSessionId?: string;
    },
  ): void {
    this.repo.store.atomic((_db) => {
      const before = this.session(id);
      if (
        (before.backend && before.backend !== identity.backend) ||
        (before.instanceId && before.instanceId !== identity.instanceId) ||
        (before.nativeSessionId &&
          identity.nativeSessionId &&
          before.nativeSessionId !== identity.nativeSessionId)
      )
        throw new Error("Provider session identity conflicts with its durable binding");
      this.repo.store
        .statement(`UPDATE engine_sessions SET backend=?, instance_id=?,
        native_session_id=COALESCE(?,native_session_id) WHERE thread_id=?`)
        .run(identity.backend, identity.instanceId, identity.nativeSessionId ?? null, id);
    });
  }
  backend(id: ThreadId): ProviderBackend | undefined {
    // Recovery and teardown also read the binding of a tombstoned thread. They must
    // not resolve its execution workspace, which intentionally rejects deleted threads.
    const backend = this.repo.store.atomic((_db) => {
      const row = this.repo.store
        .statement("SELECT backend FROM engine_sessions WHERE thread_id=?")
        .get(id);
      if (!row) throw new Error("Missing engine session metadata");
      return row.backend == null ? undefined : z.enum(["acp", "cursor-sdk"]).parse(row.backend);
    });
    if (backend) return backend;
    return this.repo.requireState(id).config.provider === "cursor" ? "acp" : undefined;
  }
}
