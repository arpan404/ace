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
import { boundary, handoff, validateCitations } from "./transition-history.ts";

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
        // Forking into another account needs migration; request a switch on the fork instead.
        if (
          selection.provider === inherited.provider &&
          selection.instanceId !== inherited.instanceId
        )
          return fail("fork_account_mismatch_use_switch");
        const entry = registry.get(selection.provider);
        const capabilities = entry.capabilities;
        const instanceId =
          selection.instanceId ?? selectInstance?.(selection.provider, entry.adapter.backend);
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
          selection.provider === source?.selection.provider &&
          capabilities.fork &&
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
        const identity = p.selection.provider === "acp" ? AcpIdentity.safeParse(thread) : undefined;
        if (p.selection.provider === "acp" && !identity?.success)
          return fail("acp_identity_required");
        if (!registry.has(p.selection.provider, identity?.success ? identity.data : undefined))
          return fail("provider_unavailable");
        const metadata = repo.session(id);
        const fallback: ExecutionSelection = {
          provider: state.config.provider,
          options: {},
          ...metadata,
        };
        const selection = repo.transitions.selection(id, fallback, p.selection);
        if (
          Object.keys(selection.options).length &&
          !registry.get(
            selection.provider,
            selection.provider === state.config.provider ? repo.backend(id) : undefined,
          ).capabilities.sessionOptions
        )
          return fail("provider_options_unsupported");
        repo.transitions.remember(id, repo.transitions.get(id).selection ?? fallback);
        if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
        // Last selection wins while queued; in-flight transitions cannot be overwritten.
        for (const previous of repo.pending.headers(id))
          if (previous.kind === "thread.switch") {
            if (previous.status === "running") return fail("switch_in_progress");
            repo.mark(previous, "done");
          }
        const lossy = selection.provider !== state.config.provider;
        repo.store.appendEvents(
          id,
          [
            {
              type: "thread.updated",
              switch: {
                selection,
                state: "queued",
                lossy,
                ...(lossy ? { recommendation: "delegate_task" } : {}),
                at: now,
              },
            },
          ],
          now,
        );
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
