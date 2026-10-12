import { createHash } from "node:crypto";
import { ThreadId, type StorageReason } from "@ace/protocol";
import type { OwnedStorageCandidate, StorageOwner, StorageTarget } from "./types.ts";
import { StorageFiles, storageId } from "./files.ts";
import { hasTable, storageProtections, storageTree } from "./ownership.ts";
import { transcriptBytes } from "./transcript.ts";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class StorageInventory {
  readonly files: StorageFiles;
  private owner: StorageOwner;
  constructor(owner: StorageOwner) {
    this.owner = owner;
    this.files = new StorageFiles(owner);
  }
  thread(id: ThreadId): OwnedStorageCandidate | undefined {
    const { store } = this.owner;
    const thread = store.getThread(id);
    if (!thread) return undefined;
    const members = storageTree(store, id);
    const protections = storageProtections(this.owner, members);
    if (thread.archivedAt === undefined && thread.deletedAt === undefined)
      protections.push("not_archived");
    if (
      members.some((member) => {
        const t = store.getThread(member);
        return t && t.archivedAt === undefined && t.deletedAt === undefined;
      })
    )
      protections.push("live_thread");
    const bytes = store.atomic((db) => transcriptBytes(db, id));
    return {
      id: storageId("threads", id),
      kind: "threads",
      label: thread.title,
      bytes,
      modifiedAt: Math.max(
        thread.activityAt ?? thread.updatedAt,
        thread.archivedAt ?? 0,
        thread.deletedAt ?? 0,
      ),
      threadIds: members,
      protections,
      eligibleReason: "archived_thread",
      fingerprint: fingerprint({
        thread,
        members,
        bytes,
      }),
      target: { type: "thread", threadId: id },
    };
  }
  async attachment(hash: string): Promise<OwnedStorageCandidate | undefined> {
    const uploads = this.owner.services.context?.uploads;
    if (!uploads) throw new Error("storage_context_unavailable");
    const entry = await uploads.inspectCleanup(hash);
    return {
      id: storageId("attachments", hash),
      kind: "attachments",
      label: hash,
      bytes: entry.bytes,
      modifiedAt: entry.modifiedAt,
      fingerprint: entry.fingerprint,
      threadIds: [],
      protections: [
        ...(entry.referenced ? ["referenced" as const] : []),
        ...(entry.leased || entry.pending ? ["leased" as const] : []),
      ],
      eligibleReason: "unowned",
      target: { type: "attachment", hash },
    };
  }
  async worktree(repo: string, path: string): Promise<OwnedStorageCandidate> {
    const { store, services } = this.owner;
    const workspace = services.workspaceActions;
    if (!workspace) throw new Error("storage_git_unavailable");
    const ids = hasTable(store, "engine_sessions")
      ? store
          .statement("SELECT thread_id FROM engine_sessions WHERE cwd=? LIMIT 257")
          .all(path)
          .map((row) => ThreadId.parse(row.thread_id))
      : [];
    if (ids.length > 256) throw new Error("storage_owner_limit");
    const protections = storageProtections(this.owner, ids);
    const threads = ids.flatMap((id) => {
      const thread = store.getThread(id);
      return thread ? [thread] : [];
    });
    // A thread that still advertises this execution root must be archived before it can lose files.
    if (threads.some((thread) => thread.deletedAt === undefined && thread.archivedAt === undefined))
      protections.push("live_thread");
    if (
      store
        .statement("SELECT 1 FROM workspace_root_reservations WHERE root=? AND command_id<>?")
        .get(path, `storage:${this.owner.cleanupPlanId ?? ""}`)
    )
      protections.push("cleanup_in_progress");
    const state = await workspace.git.inspectWorktreeCleanup(repo, path);
    if (state.main) protections.push("main_worktree");
    if (state.locked) protections.push("locked_worktree");
    if (state.dirty) protections.push("uncommitted");
    if (state.unpushed) protections.push("unpushed");
    const prs = threads.flatMap((thread) => thread.details?.linkedPrs ?? []);
    const merged =
      prs.length > 0 && prs.every((pr) => pr.state === "merged" && !pr.unverified && !pr.deleted);
    const closed =
      prs.length > 0 &&
      prs.every((pr) => ["merged", "closed"].includes(pr.state) && !pr.unverified);
    const reason: StorageReason = state.missing
      ? "missing_directory"
      : merged
        ? "pr_merged"
        : closed
          ? "pr_closed"
          : ids.length
            ? "task_finished"
            : "orphaned";
    return {
      id: storageId("worktrees", `${repo}:${path}`),
      kind: "worktrees",
      label: path,
      bytes: state.bytes,
      modifiedAt: Math.max(
        state.modifiedAt,
        ...threads.map((thread) => thread.activityAt ?? thread.updatedAt),
      ),
      threadIds: ids,
      fingerprint: fingerprint({ state, owners: ids, prs }),
      protections,
      branch: state.branch,
      removeBranch: merged,
      eligibleReason: reason,
      target: {
        type: "worktree",
        repo,
        path,
        gitFingerprint: state.fingerprint,
        head: state.head,
        branch: state.branch,
      },
    };
  }
  async inspect(
    target: StorageTarget,
    kind: OwnedStorageCandidate["kind"],
  ): Promise<OwnedStorageCandidate | undefined> {
    switch (target.type) {
      case "thread":
        return this.thread(ThreadId.parse(target.threadId));
      case "attachment":
        return this.attachment(target.hash);
      case "file":
        return this.files.inspect(target.path, kind);
      case "worktree":
        return this.worktree(target.repo, target.path);
    }
  }
  async scan(): Promise<{ candidates: OwnedStorageCandidate[]; complete: boolean }> {
    const { store, services } = this.owner;
    const files = this.files.inventory();
    const candidates = [...files.candidates];
    let complete = files.complete;
    const threads = store
      .statement(`SELECT id FROM threads WHERE NOT EXISTS(SELECT 1 FROM storage_purged p WHERE p.thread_id=threads.id)
      ORDER BY COALESCE(archived_at,updated_at),id LIMIT 257`)
      .all();
    if (threads.length > 256) complete = false;
    for (const row of threads.slice(0, 256)) {
      const candidate = this.thread(ThreadId.parse(row.id));
      if (candidate) candidates.push(candidate);
    }
    if (services.context) {
      const attachments = await services.context.uploads.cleanupInventory();
      complete &&= attachments.complete;
      for (const entry of attachments.entries) {
        const candidate = await this.attachment(entry.hash);
        if (candidate) candidates.push(candidate);
      }
    }
    if (services.workspaceActions) {
      const git = services.workspaceActions.git;
      const paths = store
        .statement("SELECT DISTINCT root FROM workspace_canonical_roots LIMIT 65")
        .all();
      if (paths.length > 64) complete = false;
      for (const row of paths.slice(0, 64)) {
        if (typeof row.root !== "string") continue;
        const repo = row.root;
        const trees = await git
          .nonExecuting(() => git.listWorktrees(repo))
          .catch(() => {
            complete = false;
            candidates.push({
              id: storageId("worktrees", repo),
              kind: "worktrees",
              label: repo,
              bytes: 0,
              modifiedAt: 0,
              threadIds: [],
              fingerprint: "unavailable",
              protections: ["unknown_git_state"],
              eligibleReason: "orphaned",
              target: {
                type: "worktree",
                repo,
                path: repo,
                gitFingerprint: "unavailable",
                head: null,
                branch: null,
              },
            });
            return [];
          });
        for (const tree of trees ?? []) {
          if (candidates.length > 1024) {
            complete = false;
            break;
          }
          try {
            candidates.push(await this.worktree(repo, tree.path));
          } catch {
            complete = false;
            candidates.push({
              id: storageId("worktrees", `${repo}:${tree.path}`),
              kind: "worktrees",
              label: tree.path,
              bytes: 0,
              modifiedAt: 0,
              threadIds: [],
              fingerprint: "unavailable",
              protections: ["unknown_git_state"],
              eligibleReason: "orphaned",
              target: {
                type: "worktree",
                repo,
                path: tree.path,
                gitFingerprint: "unavailable",
                head: tree.head,
                branch: tree.branch,
              },
            });
          }
        }
      }
    }
    return { candidates, complete };
  }
}
