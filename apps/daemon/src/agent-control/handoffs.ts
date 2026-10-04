import { cleanupOwnedWorktree } from "../owned-worktree.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { z } from "zod";
import { GitService, GitError } from "@ace/git";
import {
  AcpIdentity,
  ThreadId,
  type AgentControlResult,
  type AgentId,
  type McpAttribution,
} from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import type { ExtensionOperation } from "./tools.ts";
import type { DelegationReservation } from "./journal.ts";

export type HandoffGit = Pick<
  GitService,
  "createWorktree" | "listWorktrees" | "removeWorktree" | "deleteBranch" | "resolveCommit" | "close"
>;
type Handoff = Extract<ExtensionOperation, { op: "thread.handoff" }>;
const Resource = z.object({
  child_id: ThreadId,
  repo: z.string().max(4096),
  path: z.string().max(4096),
  branch: z.string().max(256),
  base_head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  uncertain: z.number().int().min(0).max(1),
  cleanup_head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
});

/** Capacity is durable before Git starts. Failed/unaccepted work owns compensating cleanup. */
export function createHandoffs(context: ServiceContext, delegations: DelegationService) {
  const { store, config, resources, log } = context;
  const factory = context.options.agentControl?.handoffGit ?? (() => new GitService());
  const pending = new Map<
    string,
    {
      agentId: AgentId;
      threadId: ThreadId;
      branch: string;
      work: Promise<AgentControlResult>;
      cancel: () => void;
    }
  >();
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS agent_handoff_resources (
    child_id TEXT PRIMARY KEY, repo TEXT NOT NULL,path TEXT NOT NULL,branch TEXT NOT NULL,cleanup_head TEXT,base_head TEXT NOT NULL,uncertain INTEGER NOT NULL DEFAULT 1
  );`),
  );
  async function cleanup(reservation: DelegationReservation) {
    const resource = store.atomic((db) => {
      const row = db
        .prepare("SELECT * FROM agent_handoff_resources WHERE child_id=?")
        .get(reservation.record.childId);
      return row ? Resource.parse(row) : undefined;
    });
    if (resource) {
      const git = factory();
      try {
        await cleanupOwnedWorktree(
          git,
          {
            repo: resource.repo,
            path: resource.path,
            branch: resource.branch,
            baseHead: resource.base_head,
            cleanupHead: resource.cleanup_head,
            uncertain: resource.uncertain === 1,
          },
          (head) => {
            store.atomic((db) =>
              db
                .prepare("UPDATE agent_handoff_resources SET cleanup_head=? WHERE child_id=?")
                .run(head, resource.child_id),
            );
          },
        );
      } finally {
        await git.close();
      }
      store.atomic((db) =>
        db.prepare("DELETE FROM agent_handoff_resources WHERE child_id=?").run(resource.child_id),
      );
    }
    delegations.releaseReservation(reservation);
  }
  // Interrupted filesystem work is never launched at startup. Cleanup precedes new handoff admission.
  const recovery = Promise.all(
    delegations.journal
      .reservations()
      .filter((reservation) => reservation.record.resultDelivery !== "owner")
      .map((reservation) => cleanup(reservation)),
  );
  void recovery.catch((error) => log.log("error", "Handoff recovery requires cleanup", error));
  resources.onShutdown(async () => {
    for (const entry of pending.values()) entry.cancel();
    await Promise.allSettled([...pending.values()].map((entry) => entry.work));
    await recovery.catch(() => {});
  });
  async function handoff(
    caller: McpAttribution,
    operation: Handoff,
    callerSignal: AbortSignal,
  ): Promise<AgentControlResult> {
    let signal = callerSignal;
    await recovery;
    signal.throwIfAborted();
    const key = createHash("sha256")
      .update(JSON.stringify([caller.threadId, operation.requestId]))
      .digest("hex");
    const requestId = `handoff-${key}`;
    const task = `Continue thread ${operation.threadId} in this worktree. Page its transcript with ace_thread_read before starting.`;
    const receipt = delegations.journal.receipt(caller.threadId, requestId);
    if (receipt) {
      if (
        receipt.parentAgentId !== caller.agentId ||
        receipt.request.role !== `handoff: ${operation.branch}` ||
        receipt.request.task !== task
      )
        return { ok: false, code: "invalid" };
      signal.throwIfAborted();
      delegations.launch(receipt, receipt.request.task);
      return { ok: true, data: { threadId: receipt.childId } };
    }
    const source = store.getThread(operation.threadId),
      repo = source && store.getWorkspacePath(source.workspaceId);
    if (!source || !repo) return { ok: false, code: "not_found" };
    const reservation = delegations.reserve(caller, {
      requestId,
      provider: source.provider,
      ...(source.provider === "acp" ? AcpIdentity.parse(source) : {}),
      role: `handoff: ${operation.branch}`,
      task,
      wait: false,
      estimatedLoad: 0,
    });
    const watched = delegations.watchReservation(reservation);
    signal = AbortSignal.any([callerSignal, watched.signal]);
    let path = join(config.dataDir, "agent-worktrees", key);
    let committed = false;
    let git: HandoffGit | undefined;
    const cancelGit = () => {
      void git?.close();
    };
    signal.addEventListener("abort", cancelGit, { once: true });
    try {
      git = factory();
      signal.throwIfAborted();
      await mkdir(join(config.dataDir, "agent-worktrees"), { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      path = join(await realpath(join(config.dataDir, "agent-worktrees")), key);
      signal.throwIfAborted();
      const existing = (await git.listWorktrees(repo)).find((tree) => tree.path === path);
      signal.throwIfAborted();
      if (existing) throw new Error("Handoff path already occupied");
      let occupiedBranch = false;
      try {
        await git.resolveCommit({ worktree: repo, ref: `refs/heads/${operation.branch}` });
        occupiedBranch = true;
      } catch (error) {
        if (!(error instanceof GitError && error.code === "invalid_ref")) throw error;
      }
      if (occupiedBranch) throw new GitError("branch_exists", "Handoff branch already exists");
      const baseHead = await git.resolveCommit({ worktree: repo, ref: "HEAD" });
      signal.throwIfAborted();
      // This exact private path and commit are the cleanup authority.
      store.atomic((db) =>
        db
          .prepare(
            "INSERT INTO agent_handoff_resources(child_id,repo,path,branch,base_head) VALUES (?,?,?,?,?)",
          )
          .run(reservation.record.childId, repo, path, operation.branch, baseHead),
      );
      try {
        await git.createWorktree({ repo, path, baseRef: baseHead, branch: operation.branch });
        store.atomic((db) =>
          db
            .prepare(
              "UPDATE agent_handoff_resources SET cleanup_head=?,uncertain=0 WHERE child_id=?",
            )
            .run(baseHead, reservation.record.childId),
        );
      } catch (error) {
        if (
          error instanceof GitError &&
          ["branch_exists", "invalid_ref", "not_a_repo", "git_missing", "git_too_old"].includes(
            error.code,
          )
        )
          store.atomic((db) =>
            db
              .prepare("UPDATE agent_handoff_resources SET uncertain=0 WHERE child_id=?")
              .run(reservation.record.childId),
          );
        throw error;
      }
      signal.throwIfAborted();
      const result = store.atomic(() => {
        signal.throwIfAborted();
        const parentDeck = store.getThread(caller.threadId)?.deck;
        const workspace = store.createWorkspace(
          path,
          operation.branch,
          undefined,
          parentDeck ? { ...parentDeck, role: "delegate" } : undefined,
        );
        const child = delegations.prepareReserved(caller, reservation, workspace);
        signal.throwIfAborted();
        delegations.launch(child, child.request.task);
        store.atomic((db) =>
          db.prepare("DELETE FROM agent_handoff_resources WHERE child_id=?").run(child.childId),
        );
        return { ok: true, data: { threadId: child.childId, workspaceId: workspace } };
      });
      committed = true;
      return result;
    } finally {
      watched.close();
      signal.removeEventListener("abort", cancelGit);
      await git?.close();
      if (!committed) await cleanup(reservation);
    }
  }
  return {
    async execute(
      caller: McpAttribution,
      operation: Handoff,
      signal: AbortSignal,
    ): Promise<AgentControlResult> {
      signal.throwIfAborted();
      const key = `${caller.threadId}:${operation.requestId}`,
        entry = pending.get(key);
      if (entry)
        return entry.agentId === caller.agentId &&
          entry.threadId === operation.threadId &&
          entry.branch === operation.branch
          ? entry.work
          : { ok: false, code: "invalid" };
      if (pending.size >= 4) return { ok: false, code: "limit" };
      const lifetime = new AbortController();
      const work = handoff(caller, operation, AbortSignal.any([signal, lifetime.signal]));
      pending.set(key, {
        agentId: caller.agentId,
        threadId: operation.threadId,
        branch: operation.branch,
        work,
        cancel: () => lifetime.abort(),
      });
      try {
        return await work;
      } finally {
        pending.delete(key);
      }
    },
  };
}
