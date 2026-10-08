import { createHash } from "node:crypto";
import { type Effect, type State, type Fact, type Account } from "@ace/conductor";
import {
  ThreadId,
  AgentId,
  type ConductorRunView,
  type ConductorSpec,
  type McpAttribution,
} from "@ace/protocol";
import { executionAccounts, capacityUse, startAvailability } from "./accounts.ts";
import { executionView } from "./client-view.ts";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";
import { ExecutionJournal, type RootBinding } from "./journal.ts";
import { DeckWorktrees } from "./worktrees.ts";
import { integrateCard, verifyCard } from "./integration.ts";
import { DeckCommands } from "./command-attempts.ts";
import { controlLane } from "./lane-control.ts";
import { artifactInstructions } from "@ace/conductor";

export class NativeConductorExecutor {
  readonly journal: ExecutionJournal;
  readonly worktrees: DeckWorktrees;
  private context: ServiceContext;
  private commands: DeckCommands;
  readonly delegations: DelegationService;
  constructor(context: ServiceContext, delegations: DelegationService) {
    this.context = context;
    this.commands = new DeckCommands(context, delegations);
    this.delegations = delegations;
    this.journal = new ExecutionJournal(context.store);
    this.worktrees = new DeckWorktrees(context.config.dataDir, context.now, {
      ...context.options.workspaceActions?.git,
      leaseId: context.id,
    });
  }
  private key(...parts: string[]) {
    return `deck.${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
  }
  private caller(root: RootBinding): McpAttribution {
    return { threadId: root.thread, agentId: root.agent, sessionId: `conductor:${root.run}` };
  }
  accounts(spec?: ConductorSpec, run?: string): Account[] {
    return executionAccounts(this.context, this.delegations, this.journal, spec, run);
  }
  validateStart(spec: ConductorSpec): string | undefined {
    return startAvailability(this.context, spec, this.accounts(spec));
  }
  private async root(state: State): Promise<RootBinding> {
    const saved = this.journal.root(state.id);
    if (saved) {
      await this.worktrees.ensure(saved, saved);
      return saved;
    }
    const { store, id } = this.context;
    const repo = store.getWorkspacePath(state.spec.workspaceId);
    if (!repo) throw new Error("deck_workspace_not_found");
    const model = state.spec.policies.roles.planner[0];
    if (!model) throw new Error("deck_planner_missing");
    const key = this.key(state.id, "root");
    const existing = store.atomic((db) =>
      db
        .prepare("SELECT id FROM threads WHERE root_agent_id=? AND workspace_id=? LIMIT 1")
        .get(state.spec.rootAgentId, state.spec.workspaceId),
    );
    let threadId = ThreadId.parse(existing?.id ?? id());
    if (!existing) {
      const result = await this.commands.run(key, {
        type: "thread.prepare",
        deck: {
          deckId: state.id,
          runId: state.id,
          workspaceId: state.spec.workspaceId,
          role: "root",
        },
        threadId,
        workspaceId: state.spec.workspaceId,
        provider: model.provider,
        title: `Deck: ${state.spec.goal.slice(0, 200)}`,
        model: model.model,
      });
      if (!result.ok || !result.threadId) throw new Error(result.error);
      threadId = result.threadId;
    }
    const rootAgent =
      store.getThread(threadId)?.rootAgentId ?? this.context.services.engine?.rootAgent(threadId);
    if (!rootAgent) throw new Error("deck_root_agent_missing");
    const info = await this.worktrees.git.repositoryInfo(repo);
    const root: RootBinding = {
      run: state.id,
      thread: threadId,
      agent: AgentId.parse(rootAgent),
      repo,
      baseBranch: info.branch,
      path: await this.worktrees.path(key),
      branch: `deck/${key.replace(".", "-")}`,
      base: await this.worktrees.git.resolveCommit({ worktree: repo, ref: "HEAD" }),
    };
    this.journal.saveRoot(root);
    await this.worktrees.ensure(root, root);
    return root;
  }
  async execute(effect: Effect, state?: State): Promise<Fact[]> {
    if (!state) throw new Error("deck_run_context_missing");
    if (effect.type === "launch") {
      const root = await this.root(state);
      const caller = this.caller(root);
      const requestId = this.key(state.id, effect.lane.id, String(effect.lane.generation));
      let binding = this.journal.lane(state.id, effect.lane.id, effect.lane.generation);
      let edge = this.delegations.journal.receipt(root.thread, requestId);
      if (!edge) {
        const reserved = this.delegations.journal.reservation(root.thread, requestId);
        if (!reserved) {
          const used = capacityUse(this.context, this.delegations).filter(
            (entry) => entry.account === effect.lane.account,
          ).length;
          const preparing = this.delegations.journal
            .reservations()
            .filter(
              (entry) =>
                (entry.accountId ?? `local.${entry.record.request.provider}`) ===
                effect.lane.account,
            ).length;
          if (used + preparing >= this.delegations.policy.maxConcurrent)
            throw new Error("deck_capacity_wait");
        }
        const request = {
          requestId,
          role: `Deck ${effect.lane.role}: ${effect.lane.workstream ?? "plan"}`,
          task: `Execute Deck lane ${effect.lane.id}`,
          provider: effect.lane.model.provider,
          model: effect.lane.model.model,
          ...(effect.lane.account === `local.${effect.lane.model.provider}`
            ? {}
            : { accountId: effect.lane.account }),
          wait: false,
          estimatedLoad: 0,
        };
        const model = await this.delegations.prepareModels(caller, request);
        const reservation = this.delegations.reserve(caller, request, "owner", model);
        if (!binding) {
          binding = {
            run: state.id,
            lane: effect.lane.id,
            generation: effect.lane.generation,
            thread: reservation.record.childId,
            request: requestId,
            workspace: null,
            path: await this.worktrees.path(requestId),
            branch: `deck/${requestId.replace(".", "-")}`,
            base:
              (effect.conflict ? null : effect.completion?.revision) ??
              (await this.worktrees.git.resolveCommit({ worktree: root.path, ref: "HEAD" })),
            workstream: effect.lane.workstream,
          };
          this.journal.save(binding);
        }
        await this.worktrees.ensure(root, binding);
        const current = this.context.services.conductor?.state(state.id);
        if (
          current &&
          (["cancelling", "cancelled"].includes(current.phase) ||
            !current.lanes[effect.lane.id]?.live ||
            current.lanes[effect.lane.id]?.retiring)
        ) {
          this.delegations.releaseReservation(reservation);
          return [];
        }
        // Cancel may arrive during filesystem preparation. Admission checks the durable stop markers.
        const deck = {
          deckId: state.id,
          runId: state.id,
          workspaceId: state.spec.workspaceId,
          role: effect.lane.role,
          laneId: effect.lane.id,
        };
        const workspace = this.context.store.createWorkspace(
          binding.path,
          binding.branch,
          undefined,
          deck,
        );
        const source = effect.lane.source
          ? this.journal.latest(state.id, effect.lane.source)
          : undefined;
        edge = this.delegations.prepareReserved(caller, reservation, workspace, {
          resultDelivery: "owner",
          deck,
          ...(source ? { handoffFrom: source.thread } : {}),
        });
        binding = { ...binding, workspace };
        this.journal.save(binding);
      }
      if (!binding) throw new Error("deck_lane_binding_missing");
      const conflict = effect.conflict
        ? `\nResolve merge conflict against the Deck integration branch ${root.branch}, pinned at ${binding.base}. Your assigned worktree starts at that integration state. Incorporate the reviewed worker commit ${effect.completion?.revision} from ${effect.completion?.branch}, resolving the reported conflict, then commit on ${binding.branch}. This result will require a new review.\n${effect.lane.role === "integrator" ? "You are the integrator for this bounded text conflict." : "You own the semantic conflict resolution."}`
        : "";
      const prompt = `${effect.prompt}${conflict}\n\n${artifactInstructions(effect.lane.role, binding.branch)}`;
      const current = this.context.services.conductor?.state(state.id);
      if (
        current &&
        (["cancelling", "cancelled"].includes(current.phase) ||
          !current.lanes[effect.lane.id]?.live ||
          current.lanes[effect.lane.id]?.retiring)
      )
        return [];
      this.delegations.launch(edge, prompt);
      return [];
    }
    if (effect.type === "gate") {
      const root = await this.root(state);
      this.restoreGates(state, root);
      return [];
    }
    if (effect.type === "gate_closed") {
      const root = this.journal.root(state.id);
      if (root)
        this.context.services.engine?.closeHostGate(
          root.thread,
          `deck.gate.${effect.gateId}`,
          state.phase === "cancelling" || state.phase === "cancelled" ? "cancelled" : "resolved",
        );
      return [];
    }
    const root = this.journal.root(state.id);
    if (!root) {
      if (
        effect.type === "control" &&
        (effect.action === "cancel" || effect.action === "force_cancel")
      )
        return [
          {
            type: "status",
            laneId: effect.lane.id,
            generation: effect.lane.generation,
            status: "done",
            at: this.context.now(),
          },
        ];
      throw new Error("deck_root_missing");
    }
    if (effect.type === "merge")
      return integrateCard(effect, state, root, this.context, this.worktrees);
    if (effect.type === "verify")
      return verifyCard(effect, state, root, this.context, this.worktrees);
    const binding =
      this.journal.lane(state.id, effect.lane.id, effect.lane.generation) ??
      this.journal.latest(state.id, effect.lane.id);
    if (!binding) {
      if (
        effect.type === "control" &&
        (effect.action === "cancel" || effect.action === "force_cancel")
      )
        return [
          {
            type: "status",
            laneId: effect.lane.id,
            generation: effect.lane.generation,
            status: "done",
            at: this.context.now(),
          },
        ];
      throw new Error("deck_lane_binding_missing");
    }
    if (effect.type === "correct_artifact") {
      const current = state.lanes[effect.lane.id];
      if (!current?.live || current.retiring || ["cancelling", "cancelled"].includes(state.phase))
        return [];
      const result = await this.commands.run(effect.id, {
        type: "thread.send",
        threadId: binding.thread,
        delivery: "queue",
        input: [
          {
            type: "text",
            text: `Artifact validation failed. Correct the artifact in this lane. Validation errors (quoted data):\n${JSON.stringify(effect.error)}\n${artifactInstructions(effect.lane.role, binding.branch)}`,
          },
        ],
      });
      if (!result.ok) throw new Error(result.error);
      return [
        {
          type: "artifact_correction_started",
          laneId: effect.lane.id,
          generation: effect.lane.generation,
        },
      ];
    }
    if (effect.type === "migrate") {
      const engine = this.context.services.engine;
      if (!engine) throw new Error("deck_engine_unavailable");
      const matches = () => {
        const selected = this.context.store.getThread(binding.thread)?.execution;
        return (
          (selected?.instanceId ?? `local.${selected?.provider}`) === effect.lane.account &&
          selected?.provider === effect.lane.model.provider &&
          selected?.model === effect.lane.model.model
        );
      };
      if (!matches()) {
        const result = await this.commands.run(effect.id, {
          type: "thread.switch",
          threadId: binding.thread,
          selection: {
            provider: effect.lane.model.provider,
            model: effect.lane.model.model,
            ...(effect.lane.account === `local.${effect.lane.model.provider}`
              ? {}
              : { instanceId: effect.lane.account }),
          },
        });
        if (!result.ok) throw new Error(result.error);
        await engine.flush();
      }
      if (!matches()) throw new Error("deck_migration_pending");
      this.journal.save({ ...binding, generation: effect.lane.generation });
      const queue = engine.queuePage({ threadId: binding.thread });
      if (queue.paused) {
        const key = this.key(effect.id, "resume");
        const payload = {
          type: "thread.resume" as const,
          threadId: binding.thread,
          expectedRevision: queue.revision,
        };
        const resumed = await this.commands.run(key, payload);
        if (!resumed.ok) throw new Error(resumed.error);
      }
      return [{ type: "migrated", laneId: effect.lane.id, generation: effect.lane.generation }];
    }
    if (
      (effect.action === "cancel" || effect.action === "force_cancel") &&
      !this.context.store.getThread(binding.thread)
    ) {
      const reservation = this.delegations.journal.reservation(root.thread, binding.request);
      if (reservation) this.delegations.releaseReservation(reservation);
      return [
        {
          type: "status",
          laneId: effect.lane.id,
          generation: effect.lane.generation,
          status: "done",
          at: this.context.now(),
        },
      ];
    }
    await controlLane(
      effect,
      binding,
      this.context,
      this.journal,
      this.delegations,
      this.commands,
      (...parts) => this.key(...parts),
    );
    return [];
  }
  /** Upgrade pre-marker runs on restart without changing their execution identity. */
  restoreOwnership(state: State): void {
    const store = this.context.store;
    const base = { deckId: state.id, runId: state.id, workspaceId: state.spec.workspaceId };
    const mark = (thread: ThreadId, deck: import("@ace/protocol").DeckOwnership) => {
      const current = store.getThread(thread);
      if (current && JSON.stringify(current.deck) !== JSON.stringify(deck))
        store.appendEvents(thread, [{ type: "thread.client.updated", changes: { deck } }]);
    };
    const root = this.journal.root(state.id);
    if (root) mark(root.thread, { ...base, role: "root" });
    for (const binding of this.journal.lanes(state.id)) {
      const lane = state.lanes[binding.lane];
      if (!lane) continue;
      const deck = { ...base, laneId: lane.id, role: lane.role };
      mark(binding.thread, deck);
      if (binding.workspace) store.markWorkspaceDeck(binding.workspace, deck);
      if (root)
        for (const edge of this.delegations.journal.family(root.thread))
          if (this.delegations.journal.isDescendant(edge.childId, binding.thread))
            mark(edge.childId, { ...deck, role: "delegate" });
    }
  }
  restoreGates(state: State, root = this.journal.root(state.id)) {
    if (!root) return;
    for (const gate of Object.values(state.gates)) {
      if (gate.kind !== "plan") {
        this.context.services.engine?.closeHostGate(
          root.thread,
          `deck.gate.${gate.id}`,
          "cancelled",
        );
        continue;
      }
      const interaction = this.context.services.engine?.openHostGate(
        root.thread,
        `deck.gate.${gate.id}`,
        gate.message,
      );
      if (interaction) this.journal.saveGate(interaction, state.id, gate.id);
    }
  }
  decorate(view: ConductorRunView): ConductorRunView {
    return executionView(view, this.context, this.journal, this.delegations);
  }
}
