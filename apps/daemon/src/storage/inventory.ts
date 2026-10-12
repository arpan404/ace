import { ManagedWorktrees } from "../managed-worktrees.ts";
import { createHash } from "node:crypto";
import { ThreadId, type StorageReason } from "@ace/protocol";
import type { OwnedStorageCandidate, StorageOwner, StorageTarget } from "./types.ts";
import { StorageFiles, storageId } from "./files.ts";
import { storageProtections, storageTree } from "./ownership.ts";
import { transcriptBytes } from "./transcript.ts";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class StorageInventory {
  readonly files: StorageFiles;
  readonly managed: ManagedWorktrees;
  private owner: StorageOwner;
  constructor(owner: StorageOwner) {
    this.owner = owner;
    this.files = new StorageFiles(owner);
    this.managed = new ManagedWorktrees(owner.store, owner.root);
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
  async worktree(repo: string, path: string): Promise<OwnedStorageCandidate | undefined> {
    const { services } = this.owner;
    const workspace = services.workspaceActions;
    if (!workspace) throw new Error("storage_git_unavailable");
    if (!this.managed.verify(repo, path)) return undefined;
    const state = await workspace.git.inspectWorktreeCleanup(repo, path);
    // Git inspection awaits I/O. Ownership is read afterwards, and apply holds root admission.
    if (!this.managed.verify(repo, path)) return undefined;
    const { ids, protections, threads } = this.worktreeOwnership(path);
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
  worktreeOwners(path: string): ThreadId[] {
    const created = this.managed.get(path);
    return [
      ...new Set([
        ...(created ? [created.owner] : []),
        ...this.owner.store.workspaceReservations.owners([path]),
      ]),
    ];
  }
  worktreeOwnership(path: string) {
    const { store } = this.owner;
    const ids = [...new Set(this.worktreeOwners(path).flatMap((id) => storageTree(store, id)))];
    const protections = storageProtections(this.owner, ids);
    const threads = ids.flatMap((id) => {
      const thread = store.getThread(id);
      return thread ? [thread] : [];
    });
    if (
      threads.some((thread) => thread.deletedAt === undefined && thread.archivedAt === undefined) ||
      store
        .statement(`SELECT 1 FROM workspace_canonical_roots w WHERE w.root=? AND NOT EXISTS
        (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.workspace_id) LIMIT 1`)
        .get(path)
    )
      protections.push("live_thread");
    const reservation = store
      .statement("SELECT 1 FROM workspace_root_reservations WHERE root=? AND command_id<>?")
      .get(path, `storage:${this.owner.cleanupPlanId ?? ""}`);
    const repository = store.workspaceReservations.repository(path);
    if (
      reservation ||
      (repository &&
        store.workspaceReservations.repositoryReserved(repository) &&
        !store.workspaceReservations.ownsRepositoryReservation(
          repository,
          `storage:${this.owner.cleanupPlanId ?? ""}`,
        ))
    )
      protections.push("cleanup_in_progress");
    return { ids, protections, threads };
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
      case "skill_root":
        return this.files.inspectSkillRoot(target.name);
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
      const records = this.managed.list();
      if (records.length > 256) complete = false;
      for (const record of records.slice(0, 256)) {
        try {
          const candidate = await this.worktree(record.repo, record.path);
          if (candidate) candidates.push(candidate);
        } catch {
          complete = false;
          candidates.push({
            id: storageId("worktrees", `${record.repo}:${record.path}`),
            kind: "worktrees",
            label: record.path,
            bytes: 0,
            modifiedAt: record.created_at,
            threadIds: [],
            fingerprint: "unavailable",
            protections: ["unknown_git_state"],
            eligibleReason: "orphaned",
            target: {
              type: "worktree",
              repo: record.repo,
              path: record.path,
              gitFingerprint: "unavailable",
              head: null,
              branch: null,
            },
          });
        }
      }
    }
    return { candidates, complete };
  }
}
