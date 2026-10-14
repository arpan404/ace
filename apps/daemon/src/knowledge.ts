import {
  ThreadId,
  WorkspaceId,
  type ForgePrStatus,
  type McpAttribution,
  type Thread,
} from "@ace/protocol";
import type { ContextResult, ContextTopic, KnowledgePort } from "@ace/mcp-server";
import type { Store } from "./store.ts";
import type { ProjectStorage } from "./project-storage.ts";
import type { DelegationService } from "./agent-control/delegations.ts";
import { childTaskView } from "./agent-control/task-view.ts";
import { addNote, retireNote } from "./project-notes.ts";
import type { Asks } from "./asks.ts";

/** Git reads the context needs; the daemon passes a bounded GitService. */
export interface ContextGit {
  repositoryInfo(path: string): Promise<{
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  }>;
  status(path: string): Promise<{
    staged: { path: string }[];
    unstaged: { path: string }[];
    untracked: string[];
  }>;
}
export interface KnowledgeDeps {
  store: Store;
  projects(): ProjectStorage | undefined;
  delegations(): DelegationService | undefined;
  /** The linked PR's live status for a thread, from the forge; may be offline. */
  prStatus(thread: ThreadId, cwd: string, signal: AbortSignal): Promise<ForgePrStatus | null>;
  git: ContextGit;
  failures(sessionId: string): { tool: string; code: string; count: number }[];
  asks: Pick<Asks, "ask">;
  now(): number;
  id(): string;
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Project knowledge, notes, diagnostics and asks for the MCP toolkit. Reads never prompt. */
export function knowledgePort(deps: KnowledgeDeps): KnowledgePort {
  const callerThread = (caller: McpAttribution) => {
    const thread = deps.store.getThread(ThreadId.parse(caller.threadId));
    if (!thread) throw new Error("Unknown caller thread");
    return thread;
  };
  const cwd = (thread: Thread) =>
    (thread.rootAgentId && deps.store.getMcpAgent(thread.id, thread.rootAgentId)?.cwd) ||
    thread.details?.worktree ||
    deps.store.getWorkspacePath(thread.workspaceId);
  return {
    async context(caller, topics, signal) {
      const thread = callerThread(caller);
      const want = new Set<ContextTopic>(topics);
      const result: ContextResult = {};
      const recent = want.has("recent") || want.has("prs") ? recentThreads(deps, thread) : [];
      if (want.has("recent")) result.recent = recent;
      if (want.has("changes")) result.changes = await changes(deps.git, cwd(thread));
      signal.throwIfAborted();
      if (want.has("prs")) result.prs = await prs(deps, thread, cwd(thread), recent, signal);
      if (want.has("notes"))
        result.notes = (deps.projects()?.get(thread.workspaceId).notes ?? []).map((note) =>
          note.threadId
            ? { id: note.id, text: note.text, threadId: note.threadId }
            : { id: note.id, text: note.text },
        );
      if (want.has("diagnostics"))
        result.diagnostics = {
          failures: deps.failures(caller.sessionId).slice(0, 20),
          blocking: blocking(deps, thread),
        };
      return result;
    },
    async addNote(caller, text) {
      const thread = callerThread(caller);
      const projects = deps.projects();
      if (!projects) throw new Error("Projects unavailable");
      const id = deps.id();
      const project =
        projects.editNotes(WorkspaceId.parse(thread.workspaceId), (notes) =>
          addNote(notes, text, thread.id, deps.now(), id),
        ) ?? projects.get(thread.workspaceId);
      const notes = project.notes ?? [];
      const saved =
        notes.find((note) => note.id === id) ??
        notes.find((note) => note.text === text.replace(/\s+/g, " ").trim());
      return { noteId: saved?.id ?? id, notes: notes.length };
    },
    async retireNote(caller, noteId) {
      const thread = callerThread(caller);
      const projects = deps.projects();
      if (!projects) throw new Error("Projects unavailable");
      const changed = projects.editNotes(WorkspaceId.parse(thread.workspaceId), (notes) =>
        retireNote(notes, noteId),
      );
      return { retired: changed !== undefined };
    },
    ask: (caller, input, signal) => deps.asks.ask(caller, input, signal),
  };
}

function recentThreads(deps: KnowledgeDeps, self: Thread): NonNullable<ContextResult["recent"]> {
  const ids = deps.store.atomic((db) =>
    db
      .prepare(
        "SELECT id FROM threads WHERE workspace_id=? AND id<>? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 10",
      )
      .all(self.workspaceId, self.id)
      .map((row) => ThreadId.parse(row["id"])),
  );
  return ids.flatMap((id) => {
    const thread = deps.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return [];
    const outcome = deps.delegations()?.journal.get(id)?.outcome?.result ?? lastAnswer(deps, id);
    const linked = (thread.details?.linkedPrs ?? []).slice(0, 8);
    return [
      {
        threadId: id,
        title: thread.title.slice(0, 256),
        status: thread.status.state,
        updatedAt: thread.updatedAt,
        ...(thread.details?.branch ? { branch: thread.details.branch.slice(0, 256) } : {}),
        ...(linked.length
          ? { prs: linked.map((pr) => ({ number: pr.number, state: pr.state, url: pr.url })) }
          : {}),
        ...(outcome ? { outcome: oneLine(outcome, 400) } : {}),
      },
    ];
  });
}

/** The thread's latest assistant answer, from its retained tail. */
function lastAnswer(deps: KnowledgeDeps, id: ThreadId): string | undefined {
  const items = deps.store.readItemPage(id, deps.store.headSeq() + 1, 20, 32 * 1024).items;
  for (const item of items.toReversed())
    if (item.type === "message" && item.role === "assistant") {
      const text = item.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ");
      if (text.trim()) return text;
    }
  return undefined;
}

async function changes(git: ContextGit, path: string | undefined) {
  if (!path) return null;
  try {
    const [info, status] = await Promise.all([git.repositoryInfo(path), git.status(path)]);
    const files = [
      ...new Set([...status.staged, ...status.unstaged].map((entry) => entry.path)),
      ...status.untracked,
    ];
    return {
      branch: info.branch,
      upstream: info.upstream,
      ahead: info.ahead,
      behind: info.behind,
      staged: status.staged.length,
      unstaged: status.unstaged.length,
      untracked: status.untracked.length,
      files: files.slice(0, 50).map((file) => file.slice(0, 1024)),
    };
  } catch {
    return null;
  }
}

async function prs(
  deps: KnowledgeDeps,
  self: Thread,
  cwd: string | undefined,
  recent: NonNullable<ContextResult["recent"]>,
  signal: AbortSignal,
): Promise<NonNullable<ContextResult["prs"]>> {
  const own = self.details?.linkedPrs ?? [];
  let live: ForgePrStatus | null = null;
  if (own.length && cwd)
    try {
      live = await deps.prStatus(
        self.id,
        cwd,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      );
    } catch {
      /* Offline or signed out: CI stays unknown. */
    }
  const listed = [
    ...own.map((pr) => ({ threadId: self.id, pr })),
    ...recent.flatMap((thread) =>
      (deps.store.getThread(ThreadId.parse(thread.threadId))?.details?.linkedPrs ?? []).map(
        (pr) => ({
          threadId: thread.threadId,
          pr,
        }),
      ),
    ),
  ];
  return listed.slice(0, 20).map(({ threadId, pr }) => {
    const entry: NonNullable<ContextResult["prs"]>[number] = {
      threadId,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      ci: live && threadId === self.id && live.ref.number === pr.number ? live.ci : "unknown",
    };
    if (pr.title) entry.title = pr.title.slice(0, 256);
    return entry;
  });
}

/** Plain reasons this thread has not settled, from canonical status and its children. */
function blocking(deps: KnowledgeDeps, thread: Thread): string[] {
  const reasons: string[] = [];
  const status = thread.status;
  if (status.state === "needs_you")
    reasons.push(`${status.interactions} request(s) here wait on the person`);
  if (status.state === "waiting") reasons.push(`waiting on ${status.on.replaceAll("_", " ")}`);
  for (const watched of thread.live?.watching ?? [])
    reasons.push(`background work still running: ${oneLine(watched.title, 120)}`);
  const delegations = deps.delegations();
  if (delegations) {
    const root = delegations.journal.get(thread.id)?.rootId ?? thread.id;
    for (const edge of delegations.journal.family(root))
      if (edge.parentId === thread.id) {
        const view = childTaskView(deps.store, delegations.journal, edge.childId)?.view;
        if (view && ["working", "waiting_on_human", "waiting_on_children"].includes(view.state))
          reasons.push(`child ${edge.childId.slice(0, 8)} is ${view.state.replaceAll("_", " ")}`);
      }
  }
  return reasons.slice(0, 16);
}
