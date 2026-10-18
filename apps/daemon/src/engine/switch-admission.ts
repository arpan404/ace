import { switchRoute } from "@ace/core";
import type { Capabilities, ExecutionSelection, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** What a thread runs on when it has never switched: its provider and its session metadata. */
function running(repo: EngineRepository, id: ThreadId): ExecutionSelection {
  return {
    provider: repo.requireState(id).config.provider,
    options: {},
    ...repo.session(id),
  };
}

/**
 * Resolves the selection a pending switch would apply, or names why the thread can't take it.
 * `capabilities` reads the destination provider's capabilities. Nothing is written.
 */
export function resolveSwitch(
  repo: EngineRepository,
  id: ThreadId,
  requested: {
    provider: ExecutionSelection["provider"];
    model?: string | undefined;
    instanceId?: string | undefined;
    options?: ExecutionSelection["options"] | undefined;
  },
  capabilities: (provider: ExecutionSelection["provider"]) => Capabilities,
): ExecutionSelection | string {
  const fallback = running(repo, id);
  const selection = repo.transitions.selection(id, fallback, requested);
  const current = repo.transitions.get(id).selection ?? fallback;
  if (switchRoute({ ...current, backend: repo.backend(id) }, selection) === "new_thread")
    return "switch_requires_new_thread";
  if (Object.keys(selection.options).length && !capabilities(selection.provider).sessionOptions)
    return "provider_options_unsupported";
  // Last selection wins while queued; an in-flight transition cannot be overwritten.
  for (const previous of repo.pending.headers(id))
    if (previous.kind === "thread.switch" && previous.status === "running")
      return "switch_in_progress";
  return selection;
}

/**
 * Makes `selection` the thread's one pending switch: earlier queued switches are superseded and
 * clients see it queued. The caller adds the switch intent itself.
 */
export function recordSwitch(
  repo: EngineRepository,
  id: ThreadId,
  selection: ExecutionSelection,
  at: number,
): void {
  const fallback = running(repo, id);
  repo.transitions.remember(id, repo.transitions.get(id).selection ?? fallback);
  for (const previous of repo.pending.headers(id))
    if (previous.kind === "thread.switch") repo.mark(previous, "done");
  const lossy = selection.provider !== fallback.provider;
  repo.store.appendEvents(
    id,
    [
      {
        type: "thread.updated",
        switch: {
          selection,
          state: "queued",
          lossy,
          ...(lossy ? { recommendation: "delegate" } : {}),
          at,
        },
      },
    ],
    at,
  );
}
