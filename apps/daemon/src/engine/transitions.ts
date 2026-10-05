import type { EngineModels } from "./models.ts";
import { renderHandoff } from "@ace/handoff";
import type { MigrationResult } from "@ace/protocol/accounts";
import type { ExecutionSelection, ThreadId } from "@ace/protocol";
import type { EngineRepository, Intent } from "./repository.ts";
import type { ThreadActor } from "./actor.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { NativeFork } from "./transition-state.ts";
import type { z } from "zod";
import type { Sessions } from "./sessions.ts";
import { handoff, validateCitations } from "./transition-history.ts";
import { admitTransitionMetadata } from "./transition-state.ts";
export interface TransitionIO {
  migrate(request: {
    provider: ExecutionSelection["provider"];
    nativeSessionId: string;
    from: string;
    to: string;
  }): Promise<MigrationResult>;
  applyPatch(request: { worktree: string; patch: string }): Promise<void>;
}
export class ThreadTransitions {
  private repo: EngineRepository;
  private registry: AdapterRegistry;
  private sessions: Sessions;
  private io: TransitionIO;
  private now: () => number;
  private models: EngineModels;
  private closeThread: (id: ThreadId) => Promise<void>;
  constructor(
    repo: EngineRepository,
    registry: AdapterRegistry,
    sessions: Sessions,
    io: TransitionIO,
    now: () => number,
    models: EngineModels,
    closeThread: (id: ThreadId) => Promise<void>,
  ) {
    this.repo = repo;
    this.registry = registry;
    this.sessions = sessions;
    this.io = io;
    this.now = now;
    this.closeThread = closeThread;
    this.models = models;
  }
  async execute(actor: ThreadActor, intent: Intent): Promise<void> {
    const p = intent.command.payload;
    if (p.type === "thread.merge") {
      const fork = this.repo.store.getThread(p.threadId);
      if (fork?.lineage?.parentThreadId !== actor.id) throw new Error("Fork lineage changed");
      validateCitations(
        this.repo,
        p.threadId,
        p.citations.map((citation) => citation.itemId),
      );
      const text = JSON.stringify({
        type: "merged_fork_context",
        sourceThreadId: p.threadId,
        summary: p.summary,
        citations: p.citations,
      });
      const previous = this.repo.transitions.get(actor.id);
      this.repo.transitions.history.admit(actor.id, p.threadId);
      // Parse every per-entry and aggregate constraint before irreversible git effects.
      const next = admitTransitionMetadata({ ...previous, context: [...previous.context, text] });
      if (p.patch) {
        await this.closeThread(p.threadId);
        await this.closeThread(actor.id);
        await this.io.applyPatch({ worktree: this.repo.session(actor.id).cwd, patch: p.patch });
      }
      this.repo.store.atomic(() => {
        this.repo.transitions.history.grant(actor.id, p.threadId, this.repo.store.headSeq());
        this.repo.transitions.set(actor.id, next);
        actor.apply([
          {
            type: "item.upsert",
            agent: "root",
            item: `merge:${intent.id}`,
            draft: {
              type: "message",
              role: "user",
              synthetic: true,
              mergedContext: {
                sourceThreadId: p.threadId,
                summary: p.summary,
                citations: p.citations,
                patchApplied: p.patch !== undefined,
              },
              complete: true,
              parts: [{ type: "text", text }],
            },
          },
        ]);
      });
      return;
    }
    if (p.type !== "thread.switch") throw new Error("Unknown transition");
    const previous = this.repo.transitions.get(actor.id);
    const metadata = this.repo.session(actor.id);
    const state = this.repo.requireState(actor.id);
    const current: ExecutionSelection = previous.selection ?? {
      provider: state.config.provider,
      options: {},
      ...metadata,
    };
    const requested = this.repo.transitions.selection(actor.id, current, p.selection);
    const selection = await this.models.prepare(requested);
    const crossProvider = selection.provider !== current.provider;
    const crossAccount = !crossProvider && selection.instanceId !== current.instanceId;
    const backend = this.repo.backend(actor.id);
    const entry = this.registry.get(selection.provider, crossProvider ? undefined : backend);
    const capabilities = entry.capabilities;
    // SDK stores are pinned to the thread and account. The CLI portability driver
    // cannot copy them, and clearing native identity would reclaim old checkpoints.
    if (
      (crossAccount || crossProvider) &&
      (backend === "cursor-sdk" || entry.adapter.backend === "cursor-sdk")
    )
      throw new Error(
        "Cursor SDK runtime/account changes require a fresh portable fork or thread.create with handoffFrom; the source checkpoint is preserved",
      );
    if (
      !crossProvider &&
      metadata.nativeSessionId &&
      !capabilities.resume &&
      (!actor.session?.configure || crossAccount)
    )
      throw new Error("Provider cannot continue its native session");
    this.repo.transitions.admitModel(actor.id, selection);
    const portable = crossProvider
      ? handoff(this.repo, actor.id, this.repo.store.headSeq(), 16384, current.provider)
      : undefined;
    let nativeSessionId = metadata.nativeSessionId;
    let migratedFork: z.infer<typeof NativeFork> | undefined;
    if (crossAccount) {
      if (!nativeSessionId || !current.instanceId || !selection.instanceId)
        throw new Error("Account changes require a pinned native session and destination account");
      await this.sessions.close(actor, "idle");
      const migration = await this.io.migrate({
        provider: selection.provider,
        nativeSessionId,
        from: current.instanceId,
        to: selection.instanceId,
      });
      if (migration.status !== "migrated") throw new Error(migration.reason);
      if (migration.cleanupWarnings?.includes("lease_release_failed"))
        throw new Error("Migration lease release failed");
      nativeSessionId = migration.nativeSessionId;
      if (
        migration.action === "fork" &&
        capabilities.fork &&
        capabilities.forkPoints?.includes("end")
      ) {
        migratedFork = { nativeSessionId, point: { type: "end", nativeId: nativeSessionId } };
      } else if (migration.action === "fork") {
        const root = state.agents[state.rootKey ?? ""];
        const run = root?.lastRun ? state.runs[root.lastRun] : undefined;
        if (
          !capabilities.fork ||
          !(capabilities.forkPoints ?? []).includes("turn") ||
          !run?.nativeId
        )
          throw new Error("Migrated session requires an unsupported native fork boundary");
        migratedFork = { nativeSessionId, point: { type: "turn", nativeId: run.nativeId } };
      }
    } else if (!crossProvider && actor.session?.configure) {
      try {
        await actor.session.configure(selection);
      } catch (error) {
        try {
          await actor.session.configure(current);
        } catch {
          actor.poisoned = true;
          throw new Error(
            "Provider configuration failed and rollback failed; native session state is uncertain",
          );
        }
        throw error;
      }
    } else {
      await this.sessions.close(actor, "idle");
    }
    try {
      this.repo.store.atomic((db) => {
        if (crossProvider) this.repo.resetAdmission(actor.id);
        this.repo.transitions.remember(actor.id, selection);
        const currentState = this.repo.requireState(actor.id);
        currentState.config.provider = selection.provider;
        this.repo.save(currentState, [], this.now());
        db.prepare(
          "UPDATE engine_sessions SET model=?,instance_id=?,native_session_id=?,backend=? WHERE thread_id=?",
        ).run(
          selection.model ?? null,
          selection.instanceId ?? null,
          crossProvider || migratedFork ? null : (nativeSessionId ?? null),
          crossProvider ? (entry.adapter.backend ?? null) : (backend ?? null),
          actor.id,
        );
        this.repo.transitions.set(actor.id, {
          selection,
          context: previous.context,
          ...(migratedFork ? { fork: migratedFork } : {}),
          ...(portable
            ? { handoff: portable }
            : previous.handoff
              ? { handoff: previous.handoff }
              : {}),
        });
        this.repo.store.appendEvents(
          actor.id,
          [
            {
              type: "thread.updated",
              provider: selection.provider,
              execution: selection,
              switch: {
                selection,
                state: "applied",
                lossy: crossProvider,
                ...(crossProvider ? { recommendation: "delegate_task" } : {}),
                at: this.now(),
              },
            },
          ],
          this.now(),
        );
        actor.apply([
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            cwd: metadata.cwd,
            native: {
              provider: selection.provider,
              ...(crossProvider || !nativeSessionId ? {} : { nativeId: nativeSessionId }),
            },
            ...(selection.model ? { model: selection.model } : {}),
          },
        ]);
        if (crossProvider || crossAccount)
          actor.apply(
            Object.entries(currentState.agents)
              .filter(([, record]) => record.limited)
              .map(([agent]) => ({ type: "limit.cleared" as const, agent })),
          );
      });
    } catch (error) {
      this.repo.evict(actor.id);
      if (!crossProvider && !crossAccount && actor.session?.configure) {
        try {
          await actor.session.configure(current);
        } catch {
          actor.poisoned = true;
        }
      }
      throw error;
    }
  }
  input(id: ThreadId): string[] {
    const metadata = this.repo.transitions.get(id);
    return [...(metadata.handoff ? [renderHandoff(metadata.handoff)] : []), ...metadata.context];
  }
  /** Composer selections use the same rollback and history rules as explicit switches. */
  async selectNext(
    actor: ThreadActor,
    intent: Intent,
    model?: string,
    options?: import("@ace/protocol").ExecutionOptions,
  ): Promise<void> {
    if (model === undefined && options === undefined) return;
    const metadata = this.repo.session(actor.id);
    const current = this.repo.transitions.get(actor.id).selection ?? {
      provider: this.repo.requireState(actor.id).config.provider,
      options: {},
      ...metadata,
    };
    await this.execute(actor, {
      ...intent,
      command: {
        ...intent.command,
        payload: {
          type: "thread.switch",
          threadId: actor.id,
          selection: {
            provider: current.provider,
            ...(current.instanceId ? { instanceId: current.instanceId } : {}),
            ...(model === undefined ? (current.model ? { model: current.model } : {}) : { model }),
            ...(options === undefined ? {} : { options }),
          },
        },
      },
    });
  }
  async freezeForkSource(source: ThreadId, fork: ThreadId): Promise<void> {
    const metadata = this.repo.transitions.get(fork);
    if (metadata.fork?.point.type !== "end") return;
    if (metadata.fork.nativeSessionId !== this.repo.session(source).nativeSessionId)
      throw new Error("Whole-session fork source changed before snapshot creation");
    await this.closeThread(source);
  }
  delivered(id: ThreadId): void {
    const metadata = this.repo.transitions.get(id);
    delete metadata.handoff;
    metadata.context = [];
    this.repo.transitions.set(id, metadata);
  }
}
