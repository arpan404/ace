import { delegationModel } from "./models.ts";
import { callerThread } from "./authorization.ts";
import { admitDelegation, delegationBudget } from "@ace/orchestrator";
import { pickInstance } from "@ace/accounts";
import { AccountProvider } from "@ace/protocol/accounts";
import {
  Command,
  AcpIdentity,
  DelegationRequest,
  ThreadId,
  type McpAttribution,
  type WorkspaceId,
} from "@ace/protocol";
import type { DelegationDependencies } from "./delegations.ts";
import type { DelegationJournal, DelegationReservation } from "./journal.ts";
import { controlCommandId } from "./command-id.ts";

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
  private validate(caller: McpAttribution, input: DelegationRequest) {
    if (!this.admits()) throw new Error("Admission closed");
    callerThread(this.deps.store, caller);
    if (
      this.journal.get(caller.threadId)?.phase === "cancelling" ||
      this.journal.stopped(caller.threadId) ||
      this.journal.ancestorStopped(caller.threadId)
    )
      throw new Error("cancelled");
    if (input.provider === "acp") {
      const identity = AcpIdentity.parse(input);
      if (input.accountId && input.accountId !== identity.instanceId)
        throw new Error("Account identity mismatch");
    }
    const capabilities = this.deps.engine.capabilities(input.provider);
    if (
      Object.keys(input.options ?? {}).some(
        (key) => !capabilities.launchOptions?.some((supported) => supported === key),
      )
    )
      throw new Error("launch_options_unsupported");
  }
  reserve(
    caller: McpAttribution,
    value: DelegationRequest,
    resultDelivery?: "owner",
    configuredModel?: string,
  ): DelegationReservation {
    const input = DelegationRequest.parse(value);
    return this.deps.store.atomic(() => {
      this.validate(caller, input);
      const existing = this.journal.reservation(caller.threadId, input.requestId);
      if (existing) {
        this.match(caller, input, existing.record);
        if (existing.record.resultDelivery !== resultDelivery)
          throw new Error("Reservation owner mismatch");
        return existing;
      }
      const now = this.deps.clock.now(),
        tree = this.journal.tree(caller.threadId, now);
      const rejection = admitDelegation(
        { ...tree, concurrent: this.journal.concurrent(caller.threadId) },
        this.policy,
        now,
      );
      if (rejection || this.journal.activeCount() >= 64)
        throw new Error(rejection ?? "active_limit");
      this.journal.assertCapacity();
      const provider = AccountProvider.safeParse(
        input.provider === "acp" ? undefined : input.provider,
      );
      const candidates = provider.success
        ? (this.deps.accounts
            ?.list()
            .filter(
              (entry) =>
                entry.instance.provider === provider.data &&
                (input.accountId
                  ? entry.instance.id === input.accountId
                  : !entry.instance.implicit),
            ) ?? [])
        : [];
      const selected = provider.success
        ? pickInstance(
            { provider: provider.data, role: input.role, estimatedLoad: input.estimatedLoad },
            candidates,
            now,
          )
        : undefined;
      if (provider.success && (input.accountId || candidates.length > 0) && !selected)
        throw new Error("Account unavailable or quota exhausted");
      const resolvedModel = delegationModel(
        this.deps.models,
        input,
        callerThread(this.deps.store, caller),
        selected?.id ?? input.instanceId ?? `${input.provider}-cli-default`,
        configuredModel,
      );
      const reservation: DelegationReservation = {
        record: {
          childId: ThreadId.parse(this.deps.id()),
          parentId: caller.threadId,
          parentAgentId: caller.agentId,
          rootId: tree.root,
          requestId: input.requestId,
          request: input,
          ...(resolvedModel ? { resolvedModel } : {}),
          depth: tree.depth + 1,
          createdAt: now,
          phase: "created",
          generation: 0,
          ...(resultDelivery ? { resultDelivery } : {}),
        },
        ...(selected ? { accountId: selected.id } : {}),
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
      JSON.stringify(record.request) !== JSON.stringify(input)
    )
      throw new Error("Request identity conflict");
  }
  commit(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
    ownership?: {
      resultDelivery: "owner";
      handoffFrom?: ThreadId;
      deck?: import("@ace/protocol").DeckOwnership;
    },
  ) {
    return this.deps.store.atomic(() => {
      const requested = reservation.record;
      const current = this.journal.reservation(caller.threadId, requested.requestId);
      if (!current || current.record.childId !== requested.childId)
        throw new Error("Reservation expired");
      this.match(caller, requested.request, current.record);
      const r = current.record;
      if (ownership) r.resultDelivery = ownership.resultDelivery;
      this.validate(caller, r.request);
      const tree = this.journal.tree(caller.threadId, this.deps.clock.now());
      const rejection = tree.cancelled
        ? "cancelled"
        : delegationBudget(tree, this.policy, this.deps.clock.now());
      if (rejection) throw new Error(rejection);
      // Quota may have changed during filesystem work; selected identity is immutable.
      if (current.accountId) {
        const account = this.deps.accounts?.get(current.accountId);
        const provider = AccountProvider.parse(r.request.provider);
        if (
          !account ||
          !pickInstance(
            { provider, role: r.request.role, estimatedLoad: r.request.estimatedLoad },
            [account],
            this.deps.clock.now(),
          )
        )
          throw new Error("Account unavailable or quota exhausted");
      }
      const identity = r.request.provider === "acp" ? AcpIdentity.parse(r.request) : undefined;
      const parentDeck = this.deps.store.getThread(r.parentId)?.deck;
      const deck =
        ownership?.deck ?? (parentDeck ? { ...parentDeck, role: "delegate" as const } : undefined);
      const result = this.deps.engine.spawn(
        Command.parse({
          id: controlCommandId(r.parentId, r.requestId, "create"),
          deviceId: "ace-agent",
          payload: {
            type: "thread.prepare",
            ...(deck ? { deck } : {}),
            ...(ownership?.handoffFrom ? { handoffFrom: ownership.handoffFrom } : {}),
            threadId: r.childId,
            workspaceId: workspace,
            provider: r.request.provider,
            ...identity,
            title: r.request.role.slice(0, 256),
            ...(r.resolvedModel ? { model: r.resolvedModel } : {}),
            ...(r.request.options ? { options: r.request.options } : {}),
            ...(current.accountId ? { accountId: current.accountId } : {}),
          },
        }),
        {
          parentThreadId: r.parentId,
          ...(r.request.permissionMode ? { permissionMode: r.request.permissionMode } : {}),
        },
      );
      if (!result.ok) throw new Error(result.error);
      const child = this.deps.store.getThread(r.childId);
      if (!child) throw new Error("Child creation failed");
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
