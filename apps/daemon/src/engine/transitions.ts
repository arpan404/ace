import type { EngineModels } from "./models.ts";
import { handoffSources, renderHandoff } from "@ace/handoff";
import type { MigrationResult } from "@ace/protocol/accounts";
import type { ExecutionSelection, ThreadId } from "@ace/protocol";
import type { EngineRepository, Intent } from "./repository.ts";
import type { ThreadActor } from "./actor.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { NativeFork } from "./transition-state.ts";
import type { z } from "zod";
import type { Sessions } from "./sessions.ts";
import { validateCitations } from "./transition-history.ts";
import { lateForkHistoryFacts } from "./fork-history.ts";
import { abandonReturn, planCrossProvider, type CrossProviderPlan } from "./provider-return.ts";
import { routeAccountChange } from "./account-route.ts";
import { admitTransitionMetadata } from "./transition-state.ts";
import { acpAgentRequired, switchNeedsNewThread } from "./failure-copy.ts";
import { switchAgent } from "./switch-admission.ts";
import { switchRoute } from "@ace/core";
/**
 * What a cross-provider switch carries, rendered: about 8k tokens. Enough for the opening ask,
 * the latest exchange and recent work; older items stay one handoff_read away.
 */
const switchHandoffBytes = 32768;
export interface TransitionIO {
  migrate(request: {
    provider: ExecutionSelection["provider"];
    nativeSessionId: string;
    from: string;
    to: string;
  }): Promise<MigrationResult>;
  /** Why the destination account can't take the thread now (unknown, signed out, exhausted). */
  accountProblem?(provider: ExecutionSelection["provider"], instanceId: string): string | undefined;
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
    const held = this.repo.queue.get(actor.id);
    // A catalog disappearance may precede the first failed send on a saved thread.
    let missingModel = false;
    if (current.model && held.paused && !held.limited && held.reason !== "uncertain") {
      try {
        this.models.select(
          current.provider,
          current.model,
          current.instanceId,
          this.models.identity(actor.id),
        );
      } catch {
        missingModel = true;
      }
    }
    const thread = this.repo.store.getThread(actor.id);
    const acpAgent = thread ? switchAgent(thread, p.selection) : undefined;
    if (acpAgent === "required") throw new Error(acpAgentRequired);
    const requested = this.repo.transitions.selection(actor.id, current, p.selection);
    const selection = await this.models.prepare(requested, acpAgent);
    // Another ACP agent is another agent, so it continues the way another provider does.
    const otherAgent =
      acpAgent !== undefined &&
      current.provider === "acp" &&
      thread?.instanceId !== acpAgent.instanceId;
    const crossProvider = selection.provider !== current.provider || otherAgent;
    const crossAccount = !crossProvider && selection.instanceId !== current.instanceId;
    const backend = this.repo.backend(actor.id);
    const entry = this.registry.get(selection.provider, crossProvider ? undefined : backend);
    const capabilities = entry.capabilities;
    // Existing SDK stores are pinned to the thread and account. Entering the SDK uses a fresh
    // session; leaving it or changing accounts continues in a portable fork (clients route the
    // next message there). Admission refuses these; a switch queued before then lands here.
    const route = switchRoute(
      { ...current, backend },
      { ...selection, acpAgentId: acpAgent?.acpAgentId },
    );
    if (route === "new_thread") throw new Error(switchNeedsNewThread);
    if (route === "unsupported") throw new Error(acpAgentRequired);
    if (
      !crossProvider &&
      !crossAccount &&
      metadata.nativeSessionId &&
      !capabilities.resume &&
      !actor.session?.configure
    )
      throw new Error("Provider cannot continue its native session");
    const unusable =
      crossAccount && selection.instanceId
        ? this.io.accountProblem?.(selection.provider, selection.instanceId)
        : undefined;
    if (unusable) throw new Error(unusable);
    this.repo.transitions.admitModel(actor.id, selection);
    let nativeSessionId = metadata.nativeSessionId;
    let migratedFork: z.infer<typeof NativeFork> | undefined;
    let plan: CrossProviderPlan | undefined;
    // A native fork whose provider would bring the source's turns along, leaving that path before
    // it opened: its copies are written in the switch's commit, before the handoff built from
    // them, so its transcript and the next agent both hold the history.
    const lateHistory =
      !!previous.fork &&
      !!this.registry.get(current.provider, backend).capabilities.forkTranscript &&
      (crossProvider || crossAccount);
    let late = lateHistory && crossProvider;
    // A late fork's plan is built in the commit, once its copies are written.
    if (crossProvider && !late)
      plan = planCrossProvider(this.repo, actor.id, {
        from: current,
        to: selection,
        resumable: capabilities.resume,
        backend: entry.adapter.backend,
        budget: switchHandoffBytes,
      });
    if (crossAccount) {
      await this.sessions.close(actor, "idle");
      const continuation = await routeAccountChange(this.repo, actor.id, {
        from: current,
        to: selection,
        nativeSessionId,
        state,
        capabilities,
        backend,
        budget: switchHandoffBytes,
        migrate: (request) => this.io.migrate({ provider: selection.provider, ...request }),
      });
      if (continuation.kind === "copied") {
        nativeSessionId = continuation.nativeSessionId;
        migratedFork = continuation.fork;
      } else {
        if (continuation.kind === "handoff") plan = continuation.plan;
        // A waiting native fork has no session of its own to copy: it rebinds, or hands off.
        late = lateHistory;
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
        if (late) {
          actor.apply(lateForkHistoryFacts(this.repo, actor.id));
          plan = planCrossProvider(this.repo, actor.id, {
            from: current,
            to: selection,
            resumable: capabilities.resume,
            backend: crossProvider ? entry.adapter.backend : backend,
            budget: switchHandoffBytes,
          });
        }
        const portable = plan?.handoff;
        const resumed = plan?.resume;
        // The session does not continue in place: a waiting handoff is replaced, not kept.
        const fresh = plan !== undefined;
        if (missingModel)
          this.repo.queue.set(actor.id, { reason: "model_unavailable" }, this.now());
        if (crossProvider) this.repo.resetAdmission(actor.id);
        this.repo.transitions.remember(actor.id, selection);
        const currentState = this.repo.requireState(actor.id);
        currentState.config.provider = selection.provider;
        this.repo.save(currentState, [], this.now());
        db.prepare(
          "UPDATE engine_sessions SET model=?,instance_id=?,native_session_id=?,backend=? WHERE thread_id=?",
        ).run(
          selection.model ?? null,
          resumed?.instanceId ?? selection.instanceId ?? null,
          fresh
            ? (resumed?.nativeSessionId ?? null)
            : migratedFork
              ? null
              : (nativeSessionId ?? null),
          crossProvider ? (entry.adapter.backend ?? null) : (backend ?? null),
          actor.id,
        );
        // A fresh or resumed session replaces any handoff still waiting for delivery; a model
        // change or a copied session keeps it for the new target.
        const waitingHandoff = fresh ? portable : previous.handoff;
        const marker = portable ? `handoff:${intent.command.id}` : previous.marker;
        this.repo.transitions.set(actor.id, {
          selection,
          context: previous.context,
          ...(migratedFork ? { fork: migratedFork } : {}),
          ...(waitingHandoff ? { handoff: waitingHandoff } : {}),
          ...(marker && waitingHandoff ? { marker } : {}),
          ...(plan?.fallback ? { fallback: plan.fallback } : {}),
        });
        const waiting = this.repo.requireState(actor.id).items[previous.marker ?? ""];
        if (!fresh && previous.handoff && previous.marker && waiting?.type === "message")
          // A model change before the handoff is delivered: its marker names the new target.
          this.repo.syntheticInput(
            actor.id,
            previous.marker,
            renderHandoff(previous.handoff),
            {
              ...(waiting.origin ?? { kind: "handoff" }),
              to: { provider: selection.provider, model: selection.model },
            },
            this.now(),
          );
        // A handoff the agent never received is replaced, not stacked: its marker goes, and any
        // new one names the models whose work is actually carried.
        if (fresh && previous.marker)
          this.repo.removeInputItem(actor.id, previous.marker, this.now());
        if (portable) {
          this.repo.syntheticInput(
            actor.id,
            `handoff:${intent.command.id}`,
            renderHandoff(portable),
            {
              kind: "handoff",
              commandId: intent.command.id,
              from: { provider: current.provider, model: current.model },
              to: { provider: selection.provider, model: selection.model },
              sources: portable.sources ?? handoffSources([], current),
              lossy: true,
              threadIds: [portable.sourceThreadId],
            },
            this.now(),
          );
        }
        this.repo.store.appendEvents(
          actor.id,
          [
            {
              type: "thread.updated",
              provider: selection.provider,
              ...(crossProvider && entry.adapter.backend ? { backend: entry.adapter.backend } : {}),
              // The previous provider's capabilities no longer describe this thread; permission
              // and option changes made before the next session opens use the new provider's.
              ...(crossProvider ? { capabilities, effectiveCapabilities: capabilities } : {}),
              // Sessions open on the thread's agent identity, so it moves with the switch.
              ...(crossProvider && acpAgent ? { acp: acpAgent } : {}),
              execution: selection,
              switch: {
                selection,
                state: "applied",
                lossy: crossProvider || portable !== undefined,
                ...(crossProvider ? { recommendation: "delegate" } : {}),
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
              ...(fresh
                ? resumed
                  ? { nativeId: resumed.nativeSessionId }
                  : {}
                : nativeSessionId
                  ? { nativeId: nativeSessionId }
                  : {}),
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
        // The provider or account leaving keeps its session for a return; it holds everything
        // written so far, this switch's own marker included.
        if ((crossProvider || crossAccount) && metadata.nativeSessionId)
          this.repo.transitions.left.leave(actor.id, {
            provider: current.provider,
            ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
            ...(backend ? { backend } : {}),
            nativeSessionId: metadata.nativeSessionId,
            throughSeq: this.repo.store.headSeq(),
          });
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
  /**
   * The usage-limit "Move to" action: the same account change a switch makes. Replayed after a
   * restart, a move that already committed is not made again. It cleared the limit with it, so
   * an automatic move finds nothing limited, and a named one finds the thread already there.
   */
  async moveAccount(
    actor: ThreadActor,
    intent: Intent,
    requested: string | undefined,
    target: () => string,
  ): Promise<void> {
    const state = this.repo.requireState(actor.id);
    const provider =
      this.repo.transitions.get(actor.id).selection?.provider ?? state.config.provider;
    if (requested !== undefined && requested === this.repo.session(actor.id).instanceId) return;
    if (requested === undefined && !Object.values(state.agents).some((agent) => agent.limited))
      return;
    await this.execute(actor, {
      ...intent,
      command: {
        ...intent.command,
        payload: {
          type: "thread.switch",
          threadId: actor.id,
          selection: { provider, instanceId: target() },
        },
      },
    });
  }
  /** A resumed return found its session gone: true when the thread now opens fresh instead. */
  abandonReturn(id: ThreadId, error: unknown): boolean {
    return abandonReturn(this.repo, id, error, this.now());
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
    delete metadata.marker;
    delete metadata.fallback;
    metadata.context = [];
    this.repo.transitions.set(id, metadata);
  }
}
