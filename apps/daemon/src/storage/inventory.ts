import { ManagedWorktrees, type ManagedWorktree } from "../managed-worktrees.ts";
import { createHash } from "node:crypto";
import { ThreadId, type StorageKind, type StorageReason } from "@ace/protocol";
import type { OwnedStorageCandidate, StorageOwner, StorageTarget } from "./types.ts";
import { StorageFiles, storageId } from "./files.ts";
import { storageProtections, storageTree } from "./ownership.ts";
import { transcriptBytes, transcriptQueries } from "./transcript.ts";

export interface StorageScan {
  candidates: OwnedStorageCandidate[];
  complete: boolean;
}

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
  async thread(
    id: ThreadId,
    queries?: readonly string[],
    going: () => boolean = () => true,
  ): Promise<OwnedStorageCandidate | undefined> {
    const { store } = this.owner;
    // Measure first: it yields to the loop. Ownership and protections are read after the last
    // await, so the candidate never carries protections older than its size.
    const bytes = await transcriptBytes(
      (sql) => store.statement(sql),
      id,
      queries ?? store.atomic((db) => transcriptQueries(db)),
      going,
    );
    const thread = store.getThread(id);
    if (!thread || bytes === undefined) return undefined;
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
    return {
      id: storageId("threads", id),
      kind: "threads",
      label: thread.title,
      bytes,
      // Last activity anywhere in the delegation tree, so a busy child keeps its parent.
      // A deleted sibling is gone: none of its timestamps are activity, or removing one
      // member would mark the rest recently modified and protect them from later rounds.
      modifiedAt: Math.max(
        ...members.map((member) => {
          const t = member === id ? thread : store.getThread(member);
          if (!t || (member !== id && t.deletedAt !== undefined)) return 0;
          return Math.max(t.activityAt ?? t.updatedAt, t.archivedAt ?? 0, t.deletedAt ?? 0);
        }),
      ),
      threadIds: members,
      protections,
      eligibleReason: thread.archivedAt === undefined ? "expired" : "archived_thread",
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
    const state = await (this.owner.worktrees ?? workspace.git).inspectWorktreeCleanup(repo, path);
    // Git inspection awaits I/O. Ownership is read afterwards, and apply holds root admission.
    if (!this.managed.verify(repo, path)) return undefined;
    const { ids, protections, threads, settledAt } = this.worktreeOwnership(path);
    if (state.main) protections.push("main_worktree");
    if (state.locked) protections.push("locked_worktree");
    if (state.dirty) protections.push("uncommitted");
    if (state.unpushed && !state.mergedIntoMain) protections.push("unpushed");
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
      ...(settledAt === undefined ? {} : { settledAt }),
      mergedIntoMain: state.mergedIntoMain,
      fingerprint: fingerprint({ state, owners: ids, prs, settledAt }),
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
        ...(settledAt === undefined ? {} : { settledAt }),
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
      threads.some(
        (thread) =>
          thread.deletedAt === undefined &&
          thread.archivedAt === undefined &&
          thread.settledAt === undefined,
      ) ||
      store
        .statement(`SELECT 1 FROM workspace_canonical_roots w WHERE w.root=? AND NOT EXISTS
        (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.workspace_id) LIMIT 1`)
        .get(path)
    )
      protections.push("live_thread");
    const reservation = store
      .statement("SELECT 1 FROM workspace_root_reservations WHERE root=? AND command_id<>?")
      .get(path, `storage:${this.owner.cleanupPlanId ?? ""}`);
    if (reservation) protections.push("cleanup_in_progress");
    const settledAt =
      threads.length && threads.every((thread) => thread.settledAt !== undefined)
        ? Math.max(
            ...threads.map((thread) => Math.max(thread.settledAt ?? 0, thread.activityAt ?? 0)),
          )
        : undefined;
    return { ids, protections, threads, settledAt };
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
  /**
   * Candidates of the requested kinds only. `complete` speaks for those kinds: a checkout Git
   * cannot inspect never makes a thread or log pass look unfinished. Thread sizes are measured
   * one statement per macrotask, so a long history never holds the event loop for the scan.
   * Once `going` turns false (the daemon is stopping) the scan ends early, incomplete.
   */
  async scan(
    kinds: ReadonlySet<StorageKind>,
    going: () => boolean = () => true,
  ): Promise<{ candidates: OwnedStorageCandidate[]; complete: boolean }> {
    const { store, services } = this.owner;
    const files = this.files.inventory(kinds);
    const candidates = [...files.candidates];
    let complete = files.complete;
    if (kinds.has("threads")) {
      const threads = store
        .statement(`SELECT id FROM threads WHERE NOT EXISTS(SELECT 1 FROM storage_purged p WHERE p.thread_id=threads.id)
        ORDER BY COALESCE(archived_at,updated_at),id LIMIT 257`)
        .all();
      if (threads.length > 256) complete = false;
      const queries = store.atomic((db) => transcriptQueries(db));
      for (const row of threads.slice(0, 256)) {
        const candidate = await this.thread(ThreadId.parse(row.id), queries, going);
        if (candidate) candidates.push(candidate);
        if (!going()) return { candidates, complete: false };
      }
    }
    if (!going()) return { candidates, complete: false };
    if (kinds.has("attachments") && services.context) {
      const attachments = await services.context.uploads.cleanupInventory();
      complete &&= attachments.complete;
      for (const entry of attachments.entries) {
        if (!going()) return { candidates, complete: false };
        const candidate = await this.attachment(entry.hash);
        if (candidate) candidates.push(candidate);
      }
    }
    if (kinds.has("worktrees") && services.workspaceActions) {
      const records = this.managed.list();
      if (records.length > 256) complete = false;
      const scan = await this.scanWorktrees(records.slice(0, 256), going);
      candidates.push(...scan.candidates);
      complete &&= scan.complete;
    }
    return { candidates, complete };
  }

  /** Inspect only the selected page; ownership and Git checks match reviewed cleanup. */
  async scanWorktrees(
    records: readonly ManagedWorktree[],
    going: () => boolean,
  ): Promise<StorageScan> {
    const candidates: OwnedStorageCandidate[] = [];
    let complete = true;
    for (const record of records) {
      if (!going()) return { candidates, complete: false };
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
    return { candidates, complete };
  }
}
