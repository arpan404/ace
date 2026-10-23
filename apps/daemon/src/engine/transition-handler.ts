import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import {
  AcpIdentity,
  ThreadId,
  type Command,
  type CommandResult,
  type ExecutionSelection,
} from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import { createEngineThread } from "./create-thread.ts";
import { forkHistoryFacts } from "./fork-history.ts";
import { boundary, handoff, validateCitations } from "./transition-history.ts";
import { recordSwitch, resolveSwitch, switchAgent } from "./switch-admission.ts";

export function acceptTransition(
  repo: EngineRepository,
  registry: AdapterRegistry,
  command: Command,
  now: number,
  nextId: () => string,
  wake: (id: ThreadId) => void,
  selectInstance?: (
    provider: string,
    backend?: import("@ace/engine-api").ProviderBackend,
  ) => string | undefined,
): CommandResult | undefined {
  const p = command.payload;
  if (p.type !== "thread.fork" && p.type !== "thread.merge" && p.type !== "thread.switch") return;
  const fail = (error: string): CommandResult => ({ commandId: command.id, ok: false, error });
  try {
    return repo.store.atomic(() => {
      const state = repo.state(p.threadId);
      const thread = repo.store.getThread(p.threadId);
      if (
        thread?.details?.workspaceChange?.state === "preparing" ||
        thread?.details?.workspaceChange?.uncertain
      )
        return fail("workspace_change_in_progress");
      if (!state || !thread) return fail("thread_not_found");
      if (repo.transitions.guarded(p.threadId)) return fail("thread_transition_in_progress");
      let id = p.threadId;
      let forkThreadId: ThreadId | undefined;
      if (p.type === "thread.fork") {
        const point = boundary(repo, id, p.point);
        const metadata = repo.session(id);
        const current: ExecutionSelection = repo.transitions.get(id).selection ?? {
          provider: state.config.provider,
          options: {},
          ...metadata,
        };
        const source = point.executionSource;
        const inherited = source?.selection ?? current;
        let selection = p.selection
          ? {
              ...p.selection,
              ...(p.selection.provider === inherited.provider &&
              p.selection.instanceId === undefined &&
              inherited.instanceId
                ? { instanceId: inherited.instanceId }
                : {}),
            }
          : inherited;
        const identity = selection.provider === "acp" ? AcpIdentity.safeParse(thread) : undefined;
        if (selection.provider === "acp" && !identity?.success)
          return fail("acp_identity_required");
        const acpIdentity = identity?.success ? identity.data : undefined;
        if (!registry.has(selection.provider, acpIdentity)) return fail("provider_unavailable");
        // A native fork reads the source account's session; on another account the fork starts
        // fresh with portable context instead (how a Cursor thread changes account, ADR 0043).
        const otherAccount =
          selection.provider === inherited.provider &&
          (selection.provider === "cursor"
            ? cursorInstanceId(selection.instanceId)
            : selection.instanceId) !==
            (inherited.provider === "cursor"
              ? cursorInstanceId(inherited.instanceId)
              : inherited.instanceId);
        const entry = registry.get(selection.provider);
        const capabilities = entry.capabilities;
        const selectedId =
          selection.instanceId ?? selectInstance?.(selection.provider, entry.adapter.backend);
        const instanceId =
          selection.provider === "cursor" ? cursorInstanceId(selectedId) : selectedId;
        if (instanceId) selection = { ...selection, instanceId };
        if (Object.keys(selection.options).length && !capabilities.sessionOptions)
          return fail("provider_options_unsupported");
        const rootId = state.agents[state.rootKey ?? ""]?.agent.id;
        const sourceNativeId =
          source &&
          (point.parentAgentId === rootId ||
            (capabilities.forkSubagents && point.sourceAgent?.fidelity === "full"))
            ? source.nativeSessionId
            : undefined;
        const supportedPoints = capabilities.forkPoints ?? [];
        const nativePoint =
          point.native && supportedPoints.includes(point.native.type)
            ? point.native
            : point.atSessionEnd && supportedPoints.includes("end")
              ? { type: "end" as const, nativeId: sourceNativeId ?? "" }
              : undefined;
        const native =
          !otherAccount &&
          selection.provider === source?.selection.provider &&
          capabilities.fork &&
          !thread.continuation &&
          sourceNativeId &&
          nativePoint
            ? { nativeSessionId: sourceNativeId, point: nativePoint }
            : undefined;
        const portable = native
          ? undefined
          : handoff(repo, id, point.throughSeq, p.budgetBytes, inherited.provider);
        id = ThreadId.parse(nextId());
        if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
        createEngineThread(repo, {
          id,
          workspaceId: thread.workspaceId,
          title: p.title ?? `${thread.title} (fork)`,
          selection,
          capabilities,
          ...(entry.adapter.backend ? { backend: entry.adapter.backend } : {}),
          cwd: metadata.cwd,
          at: now,
          silenceMs: state.config.silenceMs,
          lineage: {
            parentThreadId: thread.id,
            parentAgentId: point.parentAgentId,
            point: p.point,
            mode: native ? "native" : "portable",
            lossy: !native,
          },
          ...(acpIdentity ? { acpIdentity } : {}),
        });
        repo.transitions.set(id, {
          selection,
          context: [],
          ...(native ? { fork: native } : {}),
          ...(portable ? { handoff: portable } : {}),
        });
        // The fork's transcript opens on the conversation it continues, unless the provider's
        // own fork already brings those turns along.
        if (!(native && capabilities.forkTranscript)) {
          const copies = forkHistoryFacts(repo, thread.id, point);
          if (copies.length) repo.apply(id, copies, now);
        }
        repo.transitions.history.grant(id, thread.id, point.throughSeq);
        repo.transitions.guard(id, command.id);
        if (native?.point.type === "end") repo.transitions.guard(thread.id, command.id);
        forkThreadId = id;
      } else if (p.type === "thread.merge") {
        if (!repo.pending.headers(p.threadId)[Symbol.iterator]().next().done)
          return fail("fork_tree_is_live");
        const lineage = thread.lineage;
        if (!lineage) return fail("thread_is_not_a_fork");
        if (!repo.quiescent(state)) return fail("fork_tree_is_live");
        if (!p.citations.every((citation) => citation.threadId === p.threadId))
          return fail("invalid_citation_thread");
        validateCitations(
          repo,
          p.threadId,
          p.citations.map((citation) => citation.itemId),
        );
        id = lineage.parentThreadId;
        if (!repo.state(id)) return fail("source_thread_not_found");
        let merges = 0;
        for (const intent of repo.pending.headers(id))
          if (intent.kind === "thread.merge" && ++merges >= 8)
            return fail("merge_queue_capacity_exceeded");
        if (repo.transitions.guarded(id)) return fail("thread_transition_in_progress");
        if (p.patch && !repo.quiescent(repo.requireState(id))) return fail("source_tree_is_live");
      } else {
        const agent = switchAgent(thread, p.selection);
        if (agent === "required") return fail("acp_identity_required");
        if (!registry.has(p.selection.provider, agent)) return fail("provider_unavailable");
        const selection = resolveSwitch(
          repo,
          id,
          p.selection,
          (provider) =>
            registry.get(
              provider,
              provider === state.config.provider ? repo.backend(id) : undefined,
            ).capabilities,
        );
        if (typeof selection === "string") return fail(selection);
        if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
        recordSwitch(repo, id, selection, now);
      }
      if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
      if (p.type === "thread.merge" && p.patch) {
        repo.transitions.guard(p.threadId, command.id);
        repo.transitions.guard(id, command.id);
      }
      repo.add(command, id);
      queueMicrotask(() => wake(id));
      return { commandId: command.id, ok: true, ...(forkThreadId ? { forkThreadId } : {}) };
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
