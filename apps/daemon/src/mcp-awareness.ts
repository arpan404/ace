import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentCatalogInput, type McpAttribution, type Thread, type ThreadId } from "@ace/protocol";
import type { AwarenessPort, SessionFacts } from "@ace/mcp-server";
import type { Store } from "./store.ts";
import type { DelegationService } from "./agent-control/delegations.ts";
import { childTaskView } from "./agent-control/task-view.ts";

const liveStates = ["working", "needs_you", "waiting"];

/**
 * Facts for the session brief and change digest, read from the canonical store on every call:
 * never cached text, so a digest cannot report a stale or optimistic state.
 */
export function mcpAwareness(deps: {
  store: Store;
  delegations(): DelegationService | undefined;
  /** Project notes for the brief; absent before projects start. */
  notes(workspace: Thread["workspaceId"]): readonly string[];
  machine: string | null;
  /** Reads `.git/HEAD`; injected so tests and odd layouts can substitute it. */
  readHead?(cwd: string): string | null;
}): AwarenessPort {
  const readHead = deps.readHead ?? gitHead;
  return {
    facts(caller) {
      const thread = deps.store.getThread(caller.threadId);
      if (!thread) return undefined;
      const project = deps.store.getWorkspace(thread.workspaceId);
      const agent = thread.rootAgentId
        ? deps.store.getMcpAgent(thread.id, thread.rootAgentId)
        : undefined;
      const mode = thread.permission?.effective ?? null;
      return {
        project: project?.name ?? null,
        branch: thread.details?.branch ?? (agent?.cwd ? readHead(agent.cwd) : null) ?? null,
        worktree: thread.details?.mode === "worktree",
        machine: thread.details?.machine?.name || deps.machine,
        access: mode,
        titleProvisional: thread.titleSource === "provisional",
        liveSiblings: liveSiblings(deps.store, thread),
        children: children(deps.store, deps.delegations(), thread.id),
        pendingRequests: thread.status.state === "needs_you" ? thread.status.interactions : 0,
        notes: deps.notes(thread.workspaceId),
      };
    },
    delegates(caller: McpAttribution) {
      const delegations = deps.delegations();
      if (!delegations) return [];
      const page = delegations.catalog(caller, AgentCatalogInput.parse({ limit: 1 }));
      const byProvider = new Map<string, Set<string>>();
      for (const instance of page.instances) {
        if (!instance.installed || instance.auth === "logged_out") continue;
        const modes = byProvider.get(instance.provider) ?? new Set<string>();
        for (const mode of instance.allowedAccessModes) modes.add(mode);
        byProvider.set(instance.provider, modes);
      }
      return [...byProvider].map(([provider, modes]) => ({ provider, modes: [...modes] }));
    },
  };
}

function liveSiblings(store: Store, thread: Thread): number {
  return store.atomic((db) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM threads WHERE workspace_id=? AND id<>? AND archived_at IS NULL
         AND json_extract(status,'$.state') IN (${liveStates.map(() => "?").join(",")})`,
      )
      .get(thread.workspaceId, thread.id, ...liveStates);
    return typeof row?.["n"] === "number" ? row["n"] : 0;
  });
}

function children(
  store: Store,
  delegations: DelegationService | undefined,
  parent: ThreadId,
): SessionFacts["children"] {
  if (!delegations) return [];
  const root = delegations.journal.get(parent)?.rootId ?? parent;
  return delegations.journal
    .family(root)
    .filter((edge) => edge.parentId === parent)
    .flatMap((edge) => {
      const child = childTaskView(store, delegations.journal, edge.childId);
      return child ? [{ id: edge.childId, label: edge.request.role, state: child.view.state }] : [];
    });
}

/** The checked-out branch, from `.git/HEAD` (or a worktree's gitdir). Null when detached. */
export function gitHead(cwd: string): string | null {
  try {
    let gitDir = join(cwd, ".git");
    const pointer = readFileSync(gitDir, "utf8");
    if (pointer.startsWith("gitdir:")) gitDir = resolve(cwd, pointer.slice(7).trim());
    return parseHead(readFileSync(join(gitDir, "HEAD"), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EISDIR")
      try {
        return parseHead(readFileSync(join(cwd, ".git", "HEAD"), "utf8"));
      } catch {
        return null;
      }
    return null;
  }
}
function parseHead(head: string): string | null {
  const match = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
  return match?.[1]?.slice(0, 256) ?? null;
}
