import { ThreadId, type Command, type CommandResult, type ExecutionSelection } from "@ace/protocol";
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
        const selection = p.selection ?? current;
        if (!registry.has(selection.provider)) return fail("provider_unavailable");
        // Forking into another account needs migration; request a switch on the fork instead.
        if (selection.provider === current.provider && selection.instanceId !== current.instanceId)
          return fail("fork_account_mismatch_use_switch");
        const capabilities = registry.get(selection.provider).capabilities;
        if (Object.keys(selection.options).length && !capabilities.sessionOptions)
          return fail("provider_options_unsupported");
        const rootId = state.agents[state.rootKey ?? ""]?.agent.id;
        const sourceNativeId =
          point.parentAgentId === rootId
            ? metadata.nativeSessionId
            : capabilities.forkSubagents &&
                point.sourceAgent?.native.provider === current.provider &&
                point.sourceAgent.fidelity === "full"
              ? point.sourceAgent.native.nativeId
              : undefined;
        const supportedPoints = capabilities.forkPoints ?? [];
        const nativePoint =
          point.native && supportedPoints.includes(point.native.type)
            ? point.native
            : point.atSessionEnd && supportedPoints.includes("end")
              ? { type: "end" as const, nativeId: sourceNativeId ?? "" }
              : undefined;
        const native =
          selection.provider === current.provider &&
          capabilities.fork &&
          sourceNativeId &&
          nativePoint
            ? { nativeSessionId: sourceNativeId, point: nativePoint }
            : undefined;
        const portable = native ? undefined : handoff(repo, id, point.throughSeq, p.budgetBytes);
        id = ThreadId.parse(nextId());
        if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
        createEngineThread(repo, {
          id,
          workspaceId: thread.workspaceId,
          title: p.title ?? `${thread.title} (fork)`,
          selection,
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
        });
        repo.transitions.set(id, {
          selection,
          context: [],
          ...(native ? { fork: native } : {}),
          ...(portable ? { handoff: portable } : {}),
        });
        repo.transitions.history.grant(id, thread.id, point.throughSeq);
        forkThreadId = id;
      } else if (p.type === "thread.merge") {
        if (
          repo
            .intents(p.threadId)
            .some(
              (intent) =>
                intent.awaiting || ["pending", "queued", "running"].includes(intent.status),
            )
        )
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
        if (
          repo.intents(id).filter((intent) => intent.command.payload.type === "thread.merge")
            .length >= 8
        )
          return fail("merge_queue_capacity_exceeded");
        if (repo.transitions.guarded(id)) return fail("thread_transition_in_progress");
        if (p.patch && !repo.quiescent(repo.requireState(id))) return fail("source_tree_is_live");
      } else {
        if (!registry.has(p.selection.provider)) return fail("provider_unavailable");
        const metadata = repo.session(id);
        const fallback: ExecutionSelection = {
          provider: state.config.provider,
          options: {},
          ...metadata,
        };
        const selection = repo.transitions.selection(id, fallback, p.selection);
        if (
          Object.keys(selection.options).length &&
          !registry.get(selection.provider).capabilities.sessionOptions
        )
          return fail("provider_options_unsupported");
        repo.transitions.remember(id, repo.transitions.get(id).selection ?? fallback);
        if (!repo.reserve(id)) return fail("engine_capacity_exceeded");
        // Last selection wins while queued; in-flight transitions cannot be overwritten.
        for (const previous of repo.intents(id))
          if (previous.command.payload.type === "thread.switch") {
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
