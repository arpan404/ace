import { delegationRequest } from "./cursor-request.ts";
import { AgentControlError, ceilingRefusal, controlAdmissionError } from "./failure.ts";
import { delegationSelection, validateDelegationSelection } from "./selection.ts";
import { callerThread } from "./authorization.ts";
import { duplicateRoleProblem, internalRole, normalizeRole, roleProblem } from "./role-names.ts";
import { admitDelegation } from "@ace/orchestrator";
import {
  Command,
  AcpIdentity,
  type DelegationRequest,
  ThreadId,
  type McpAttribution,
  type WorkspaceId,
} from "@ace/protocol";
import type { DelegationDependencies } from "./delegations.ts";
import type { DelegationJournal, DelegationReservation } from "./journal.ts";
import { controlCommandId } from "./command-id.ts";
import { turnFence } from "./turn-fence.ts";

/** Reserve durable capacity before asynchronous owners perform filesystem effects. */
export class DelegationAdmission {
  private deps: DelegationDependencies;
  private journal: DelegationJournal;
  private policy: import("@ace/protocol").DelegationPolicy;
  private admits: () => boolean;

  constructor(
    deps: DelegationDependencies,
    journal: DelegationJournal,
    policy: import("@ace/protocol").DelegationPolicy,
    admits: () => boolean,
  ) {
    this.deps = deps;
    this.journal = journal;
    this.policy = policy;
    this.admits = admits;
  }
  /** `check`, resolving a stopped delegation it refuses (see `reserve`). */
  validate(caller: McpAttribution, input: DelegationRequest) {
    try {
      this.check(caller, input);
    } catch (error) {
      this.resolveRefused(caller, input.requestId, error);
      throw error;
    }
  }
  /**
   * A stopped delegation that arrived and was refused is resolved: no longer kept refused. The
   * refusal throws through every transaction the call is in, so the write waits until they have
   * all ended (they are synchronous, so a microtask runs after the outermost one); written
   * inside, a rollback would undo it.
   */
  private resolveRefused(caller: McpAttribution, requestId: string, error: unknown) {
    if (!(error instanceof AgentControlError) || error.code !== "delegation_cancelled") return;
    queueMicrotask(() => {
      try {
        this.journal.resolveStoppedCall(caller.threadId, requestId);
      } catch {
        // Kept refused: the safe side, and bounded per thread.
      }
    });
  }
  private check(caller: McpAttribution, input: DelegationRequest) {
    if (!this.admits()) throw new AgentControlError("admission_closed", "Admission closed");
    callerThread(this.deps.store, caller);
    const problem = roleProblem(input.role);
    if (problem)
      throw new AgentControlError("invalid_arguments", "generic_role", undefined, problem);
    if (!internalRole(input.role))
      this.rejectDuplicateSibling(caller.threadId, input.requestId, input.role);
    // A missing or disabled provider is the actionable cause; its policy is not checkable.
    if (this.deps.providerEnabled?.(input.provider, input.accountId ?? input.instanceId) === false)
      throw new AgentControlError("provider_disabled", `Provider ${input.provider} is disabled`);
    if (!this.deps.engine.providerAvailability(input.provider).installed)
      throw new AgentControlError(
        "provider_unavailable",
        `No installed provider adapter for ${input.provider}`,
      );
    try {
      this.deps.engine.childAccess(caller.threadId, input.provider, input.access, input);
    } catch {
      throw ceilingRefusal(
        input.provider,
        this.deps.engine.childPermissionRefusal(caller.threadId, input.provider, input),
      );
    }
    // A thread being cancelled is refused, and so is the turn a Stop stopped: a delegation from
    // it, a tool call still on its way included, comes from work the person ended. The fence
    // lifts when a newer turn runs (the next message actually dispatched), never on acceptance.
    if (this.journal.fenced(caller.threadId) || this.stoppedTurn(caller, input.requestId))
      throw new AgentControlError("delegation_cancelled", "cancelled");
    if (input.provider === "acp") {
      const identity = AcpIdentity.parse(input);
      if (input.accountId && input.accountId !== identity.instanceId)
        throw new AgentControlError("account_unavailable", "Account identity mismatch");
    }
    const capabilities = this.deps.engine.capabilities(input.provider);
    if (
      Object.keys(input.options ?? {}).some(
        (key) => !capabilities.launchOptions?.some((supported) => supported === key),
      )
    )
      throw controlAdmissionError("launch_options_unsupported");
  }
  /**
   * The call comes from work a Stop ended (`turn-fence.ts`): the stopped turn, a run that began
   * before the turn that followed it, or a delegation it had on its way. The first call made
   * from a newer turn lifts the fence; what it recorded stays refused.
   *
   * Spade's host thread runs no turn (ADR 0121): its calls are Spade's own, never a provider
   * turn's, so no turn of it was stopped and none could ever run to lift the fence. A Stop of it
   * still stops what it delegated; the cascade refuses calls while that cancellation runs.
   */
  private stoppedTurn(caller: McpAttribution, requestId: string): boolean {
    const fence = this.journal.turnFence(caller.threadId);
    if (fence === undefined) return false;
    if (this.deps.store.getThread(caller.threadId)?.host === "spade") return false;
    const origin = this.deps.engine.turnOrigin(caller.threadId, caller.agentId);
    const stopped = this.journal.stoppedCall(caller.threadId, requestId);
    const answer = turnFence(fence, { root: origin.rootTurn, origin: origin.origin, stopped });
    if (answer.kind === "lift") this.journal.liftTurnFence(caller.threadId, answer.seq);
    return answer.kind === "refuse";
  }
  /** One parent never shows two live children under the same display name. */
  private rejectDuplicateSibling(parent: ThreadId, requestId: string, role: string): void {
    const wanted = normalizeRole(role);
    const live = this.journal
      .children(parent)
      .filter((edge) => edge.phase !== "settled" && edge.requestId !== requestId)
      .some((edge) => normalizeRole(edge.request.role) === wanted);
    const reserved = this.journal
      .reservations()
      .filter((entry) => entry.record.parentId === parent && entry.record.requestId !== requestId)
      .some((entry) => normalizeRole(entry.record.request.role) === wanted);
    if (live || reserved)
      throw new AgentControlError(
        "invalid_arguments",
        "duplicate_role",
        undefined,
        duplicateRoleProblem(role),
      );
  }
  reserve(
    caller: McpAttribution,
    value: DelegationRequest,
    resultDelivery?: "owner",
    configuredModel?: string,
  ): DelegationReservation {
    const input = delegationRequest(value);
    try {
      return this.reserveChecked(caller, input, resultDelivery, configuredModel);
    } catch (error) {
      this.resolveRefused(caller, input.requestId, error);
      throw error;
    }
  }
  private reserveChecked(
    caller: McpAttribution,
    input: DelegationRequest,
    resultDelivery: "owner" | undefined,
    configuredModel: string | undefined,
  ): DelegationReservation {
    return this.deps.store.atomic(() => {
      this.check(caller, input);
      const existing = this.journal.reservation(caller.threadId, input.requestId);
      if (existing) {
        this.match(caller, input, existing.record);
        if (existing.record.resultDelivery !== resultDelivery)
          throw new Error("Reservation owner mismatch");
        return existing;
      }
      const now = this.deps.clock.now(),
        tree = this.journal.tree(caller.threadId, now);
      // Depth bounds recursion. Concurrency never refuses: excess children queue at launch.
      const rejection = admitDelegation(tree, this.policy);
      if (rejection) throw new AgentControlError("delegation_limit", rejection);
      const selected = delegationSelection(
        this.deps,
        input,
        callerThread(this.deps.store, caller),
        now,
        configuredModel,
      );
      const { resolvedModel, resolvedEffort } = selected;
      const reservation: DelegationReservation = {
        record: {
          childId: ThreadId.parse(this.deps.id()),
          parentId: caller.threadId,
          parentAgentId: caller.agentId,
          rootId: tree.root,
          requestId: input.requestId,
          request: input,
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(resolvedEffort ? { resolvedEffort } : {}),
          depth: tree.depth + 1,
          createdAt: now,
          phase: "created",
          generation: 0,
          ...(resultDelivery ? { resultDelivery } : {}),
        },
        ...(selected.accountId ? { accountId: selected.accountId } : {}),
      };
      this.journal.reserve(reservation);
      return reservation;
    });
  }
  match(
    caller: McpAttribution,
    input: DelegationRequest,
    record: import("@ace/protocol").DelegationRecord,
  ) {
    if (
      record.parentAgentId !== caller.agentId ||
      JSON.stringify(delegationRequest(record.request)) !== JSON.stringify(delegationRequest(input))
    )
      throw new AgentControlError("request_conflict", "Request identity conflict");
  }
  createThread(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
    ownership?: {
      resultDelivery: "owner";
      handoffFrom?: ThreadId;
    },
    prepared?: Pick<import("../commands.ts").CommandContext, "preparedWorkspace">,
  ) {
    return this.deps.store.atomic(() => {
      const requested = reservation.record;
      const current = this.journal.reservation(caller.threadId, requested.requestId);
      if (!current || current.record.childId !== requested.childId)
        throw new Error("Reservation expired");
      this.match(caller, requested.request, current.record);
      const r = current.record;
      if (ownership) r.resultDelivery = ownership.resultDelivery;
      this.check(caller, r.request);
      // Quota may have changed during filesystem work; selected identity is immutable.
      validateDelegationSelection(
        this.deps,
        r.request,
        r.resolvedModel,
        current.accountId,
        this.deps.clock.now(),
      );
      const identity = r.request.provider === "acp" ? AcpIdentity.parse(r.request) : undefined;
      const result = this.deps.engine.spawn(
        Command.parse({
          id: controlCommandId(r.parentId, r.requestId, "create"),
          deviceId: "ace-agent",
          payload: {
            type: "thread.prepare",
            ...(prepared?.preparedWorkspace ? { mode: "worktree" } : {}),
            ...(r.request.workspace?.kind === "new_worktree"
              ? { base: r.request.workspace.base }
              : {}),
            ...(ownership?.handoffFrom ? { handoffFrom: ownership.handoffFrom } : {}),
            threadId: r.childId,
            workspaceId: workspace,
            provider: r.request.provider,
            ...identity,
            title: r.request.role.slice(0, 256),
            titleSource: "agent",
            ...(r.resolvedModel ? { model: r.resolvedModel } : {}),
            ...(r.request.options || r.resolvedEffort
              ? {
                  options: {
                    ...r.request.options,
                    ...(r.resolvedEffort ? { effort: r.resolvedEffort } : {}),
                  },
                }
              : {}),
            ...(current.accountId ? { accountId: current.accountId } : {}),
          },
        }),
        {
          parentThreadId: r.parentId,
          ...(r.request.access ? { access: r.request.access } : {}),
        },
        prepared,
      );
      if (!result.ok) throw controlAdmissionError(result.error ?? "Child creation failed");
      const child = this.deps.store.getThread(r.childId);
      if (!child) throw new Error("Child creation failed");
      return { record: r, child };
    });
  }
  commit(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
    ownership?: { resultDelivery: "owner"; handoffFrom?: ThreadId },
    prepared?: Pick<import("../commands.ts").CommandContext, "preparedWorkspace">,
  ) {
    return this.deps.store.atomic(() => {
      const { record: r, child } = this.createThread(
        caller,
        reservation,
        workspace,
        ownership,
        prepared,
      );
      this.journal.add(r);
      this.deps.engine.attachChild(
        r.parentId,
        r.parentAgentId,
        child,
        r.request.role,
        !r.request.wait,
      );
      this.deps.engine.delegationStarted(r, child);
      return r;
    });
  }
}
