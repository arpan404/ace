import { z } from "zod";
import {
  CommandId,
  RemoteTask,
  RemoteArtifactManifest,
  type McpAttribution,
  type RemoteAgentOperation,
  type AgentControlResult,
  type RemoteTaskUsage,
  type ThreadId,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { ContextService } from "@ace/context";
import type { FilesWorkspaces } from "../files-workspaces.ts";
import { remoteContextOwner } from "./remote-identity.ts";
import { freezeRemoteAttachments } from "./remote-attachments.ts";
import { threadOutcome } from "./results.ts";
import { threadCleaning } from "../thread-cleanup-journal.ts";
const Completion = z.object({
  phase: z.enum(["completed", "failed"]),
  result: z.string(),
  usage: z.object({ tokens: z.number(), cost: z.number() }),
  truncated: z.boolean(),
  artifactsUnavailable: z.boolean().optional(),
});
const Publication = z.object({
  task: RemoteTask,
  requestId: z.string(),
  selection: z.object({ attachments: z.array(z.string()), files: z.array(z.string()) }),
  artifacts: RemoteArtifactManifest.optional(),
  frozen: z.array(z.string()).default([]),
  completion: Completion.optional(),
  sealed: Completion.optional(),
});
/** Target-owned explicit export selection. Raw broker paths never authorize output reads. */
export class RemotePublications {
  private options: {
    store: Store;
    engine: Engine;
    context?: ContextService | undefined;
    files?: FilesWorkspaces | undefined;
    hostId: string;
    usage?(threadId: ThreadId): RemoteTaskUsage;
  };
  private pending = new Map<string, AbortSignal>();
  private unsubscribe: () => void;
  constructor(options: RemotePublications["options"]) {
    this.options = options;
    options.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS remote_agent_publications(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,record JSON NOT NULL)",
      ),
    );
    // A new owner has no producer for an unfinished manifest. Finish its saved
    // completion as text-only instead of requiring a finished agent to publish again.
    const interrupted = options.store.atomic((db) =>
      db
        .prepare(
          "SELECT id FROM remote_agent_publications WHERE json_extract(record,'$.completion') IS NOT NULL AND json_extract(record,'$.artifacts') IS NULL LIMIT 10000",
        )
        .all(),
    );
    for (const row of interrupted) this.interrupted(z.string().parse(row.id));
    options.store.atomic((db) =>
      db.exec(
        "DELETE FROM remote_agent_publications WHERE json_extract(record,'$.artifacts') IS NULL AND json_extract(record,'$.sealed') IS NULL AND json_extract(record,'$.completion') IS NULL",
      ),
    );
    this.unsubscribe = options.store.subscribe((events) => {
      for (const event of events)
        if (
          event.payload.type === "thread.updated" &&
          ["done", "failed"].includes(event.payload.status?.state ?? "")
        )
          this.capture(event.threadId);
    });
    // Recover a terminal interval committed immediately before a daemon restart.
    const threads = options.store.atomic((db) => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='remote_agent_incoming'").get())
        return [];
      return db
        .prepare(`SELECT incoming.thread_id FROM remote_agent_incoming incoming
        JOIN threads ON threads.id=incoming.thread_id
        WHERE json_extract(threads.status,'$.state') IN ('done','failed')
        AND json_extract(threads.client,'$.deletedAt') IS NULL
        AND NOT EXISTS (SELECT 1 FROM remote_agent_publications publication
          WHERE publication.id=incoming.id AND json_extract(publication.record,'$.sealed') IS NOT NULL)
        LIMIT 10000`)
        .all();
    });
    for (const row of threads) this.capture(z.string().parse(row.thread_id));
  }
  close() {
    this.unsubscribe();
    for (const id of this.pending.keys()) this.interrupted(id);
  }
  /** Capture aggregate completion synchronously, before another turn can be admitted. */
  capture(threadId: string) {
    const task = this.incoming(threadId);
    if (!task || task.request.hostId !== this.options.hostId) return;
    const previous = this.outcome(task.id);
    if (previous) return previous;
    const { store } = this.options;
    const thread = store.getThread(task.threadId);
    if (
      !thread ||
      thread.deletedAt !== undefined ||
      threadCleaning(store, task.threadId) ||
      !["done", "failed"].includes(thread.status.state) ||
      store.commandReceipt(CommandId.parse(`remote-create:${task.id}`), remoteContextOwner)?.ok !==
        true ||
      store.commandReceipt(CommandId.parse(`remote-stop:${task.id}`), remoteContextOwner)?.ok ===
        true
    )
      return;
    const outcome = threadOutcome(store, thread);
    return this.seal(task, {
      phase: thread.status.state === "done" ? "completed" : "failed",
      result: outcome.result,
      truncated: outcome.truncated,
      usage: this.options.usage?.(task.threadId) ?? { tokens: 0, cost: 0 },
    });
  }
  private discardPending(id: string) {
    this.options.store.atomic((db) =>
      db
        .prepare(
          "DELETE FROM remote_agent_publications WHERE id=? AND json_extract(record,'$.artifacts') IS NULL AND json_extract(record,'$.sealed') IS NULL AND json_extract(record,'$.completion') IS NULL",
        )
        .run(id),
    );
  }
  private interrupted(id: string) {
    const record = this.read(id);
    if (!record?.completion || record.artifacts) return;
    const task = record.task;
    record.artifacts = {
      taskId: task.id,
      sourceHostId: task.sourceHostId,
      parentThreadId: task.parentThreadId,
      hostId: task.request.hostId,
      threadId: task.threadId,
      attachments: [],
    };
    record.sealed = { ...record.completion, artifactsUnavailable: true };
    this.save(record);
  }
  private read(id: string) {
    const row = this.options.store.atomic((db) =>
      db.prepare("SELECT record FROM remote_agent_publications WHERE id=?").get(id),
    );
    return row ? Publication.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  private save(record: z.infer<typeof Publication>) {
    this.options.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO remote_agent_publications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        )
        .run(record.task.id, record.task.threadId, JSON.stringify(record)),
    );
  }
  private incoming(threadId: string) {
    const store = this.options.store;
    const table = store.atomic((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE name='remote_agent_incoming'").get(),
    );
    if (!table) return;
    const row = store.atomic((db) =>
      db.prepare("SELECT record FROM remote_agent_incoming WHERE thread_id=?").get(threadId),
    );
    return row ? RemoteTask.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  private valid(task: RemoteTask, caller: McpAttribution) {
    const { store, engine, hostId } = this.options;
    const thread = store.getThread(task.threadId);
    return (
      task.request.hostId === hostId &&
      thread?.deletedAt === undefined &&
      !!thread &&
      thread.rootAgentId === caller.agentId &&
      !!store.getMcpAgent(caller.threadId, caller.agentId) &&
      engine.access(thread.id) === task.access &&
      (thread.permission?.override ?? task.access) === task.access &&
      store.commandReceipt(CommandId.parse(`remote-create:${task.id}`), remoteContextOwner)?.ok ===
        true &&
      store.commandReceipt(CommandId.parse(`remote-stop:${task.id}`), remoteContextOwner)?.ok !==
        true
    );
  }
  async publish(
    caller: McpAttribution,
    operation: Extract<RemoteAgentOperation, { op: "device.task_publish" }>,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    const task = this.incoming(caller.threadId);
    if (!task || !this.valid(task, caller)) return { ok: false, code: "forbidden" };
    const selection = { attachments: operation.attachments, files: operation.files };
    let record = this.read(task.id);
    if (
      record &&
      (record.requestId !== operation.requestId ||
        JSON.stringify(record.selection) !== JSON.stringify(selection))
    )
      return { ok: false, code: "invalid" };
    if (record?.sealed?.artifactsUnavailable) return { ok: false, code: "unavailable" };
    if (record?.artifacts) return { ok: true, data: record.artifacts };
    if (this.pending.has(task.id) || this.pending.size >= 4 || record?.sealed)
      return { ok: false, code: "not_ready" };
    if (!record) {
      const count = this.options.store.atomic((db) =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM remote_agent_publications WHERE json_extract(record,'$.sealed') IS NULL",
            )
            .get()?.n,
        ),
      );
      if (count >= 10000) return { ok: false, code: "limit" };
      record = { task, requestId: operation.requestId, selection, frozen: [] };
      this.save(record);
    }
    const publication = record;
    this.pending.set(task.id, signal);
    // Finalize completion independently of suspended reads, writes or cleanup.
    // The sealed row also fences a producer that resumes after this abort.
    const abort = () => this.interrupted(task.id);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const attachments = await freezeRemoteAttachments(
        {
          ...this.options,
          retain: (hash: string) => {
            const current = this.read(task.id) ?? publication;
            current.frozen.push(hash);
            this.save(current);
          },
        },
        task.threadId,
        selection,
        signal,
      );
      signal.throwIfAborted();
      record = this.read(task.id);
      if (!record || !this.valid(task, caller) || record.sealed)
        return { ok: false, code: "forbidden" };
      record.artifacts = {
        taskId: task.id,
        sourceHostId: task.sourceHostId,
        parentThreadId: task.parentThreadId,
        hostId: task.request.hostId,
        threadId: task.threadId,
        attachments,
      };
      if (record.completion) record.sealed = record.completion;
      this.save(record);
      return { ok: true, data: record.artifacts };
    } catch {
      signal.throwIfAborted();
      return { ok: false, code: "unavailable" };
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(task.id);
      this.interrupted(task.id);
      this.discardPending(task.id);
    }
  }
  /** Keep the first completion even when selected file freezing is still in flight. */
  private seal(
    task: RemoteTask,
    outcome: {
      phase: "completed" | "failed";
      result: string;
      truncated: boolean;
      usage: RemoteTaskUsage;
    },
  ) {
    let record = this.read(task.id);
    if (!record)
      record = {
        task,
        requestId: "",
        selection: { attachments: [], files: [] },
        frozen: [],
        artifacts: {
          taskId: task.id,
          sourceHostId: task.sourceHostId,
          parentThreadId: task.parentThreadId,
          hostId: task.request.hostId,
          threadId: task.threadId,
          attachments: [],
        },
      };
    record.completion ??= record.sealed ?? outcome;
    if (record.artifacts) record.sealed ??= record.completion;
    this.save(record);
    // Abort may precede completion while the producer remains suspended.
    if (this.pending.get(task.id)?.aborted) this.interrupted(task.id);
    return this.outcome(task.id);
  }
  outcome(id: string) {
    const record = this.read(id);
    return record?.sealed ? { ...record.sealed, artifacts: record.artifacts } : undefined;
  }
  completionPending(id: string) {
    const record = this.read(id);
    return !!record?.completion && !record.sealed;
  }
  manifest(id: string) {
    const record = this.read(id);
    return record?.sealed ? record.artifacts : undefined;
  }
  retains(thread: string, hash: string) {
    return this.options.store
      .atomic((db) =>
        db
          .prepare("SELECT record FROM remote_agent_publications WHERE thread_id=? LIMIT 10000")
          .all(thread),
      )
      .some((row) => {
        const record = Publication.parse(JSON.parse(z.string().parse(row.record)));
        return (
          record.selection.attachments.includes(hash) ||
          record.frozen.includes(hash) ||
          record.artifacts?.attachments.some((file) => file.sha256 === hash)
        );
      });
  }
}
