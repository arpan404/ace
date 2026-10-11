import { z } from "zod";
import {
  CommandId,
  RemoteTask,
  RemoteArtifactManifest,
  type McpAttribution,
  type RemoteAgentOperation,
  type AgentControlResult,
  type RemoteTaskUsage,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { ContextService } from "@ace/context";
import type { FilesWorkspaces } from "../files-workspaces.ts";
import { remoteContextOwner } from "./remote-identity.ts";
import { freezeRemoteAttachments } from "./remote-attachments.ts";
const Publication = z.object({
  task: RemoteTask,
  requestId: z.string(),
  selection: z.object({ attachments: z.array(z.string()), files: z.array(z.string()) }),
  artifacts: RemoteArtifactManifest.optional(),
  frozen: z.array(z.string()).default([]),
  sealed: z
    .object({
      phase: z.enum(["completed", "failed"]),
      result: z.string(),
      usage: z.object({ tokens: z.number(), cost: z.number() }),
      truncated: z.boolean(),
    })
    .optional(),
});
/** Target-owned explicit export selection. Raw broker paths never authorize output reads. */
export class RemotePublications {
  private options: {
    store: Store;
    engine: Engine;
    context?: ContextService | undefined;
    files?: FilesWorkspaces | undefined;
    hostId: string;
  };
  private pending = new Set<string>();
  constructor(options: RemotePublications["options"]) {
    this.options = options;
    options.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS remote_agent_publications(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,record JSON NOT NULL)",
      ),
    );
    options.store.atomic((db) =>
      db.exec(
        "DELETE FROM remote_agent_publications WHERE json_extract(record,'$.artifacts') IS NULL AND json_extract(record,'$.sealed') IS NULL",
      ),
    );
  }
  private discardPending(id: string) {
    this.options.store.atomic((db) =>
      db
        .prepare(
          "DELETE FROM remote_agent_publications WHERE id=? AND json_extract(record,'$.artifacts') IS NULL AND json_extract(record,'$.sealed') IS NULL",
        )
        .run(id),
    );
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
      engine.permissionMode(thread.id) === task.permissionMode &&
      (thread.permission?.override ?? task.permissionMode) === task.permissionMode &&
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
    this.pending.add(task.id);
    try {
      const attachments = await freezeRemoteAttachments(
        {
          ...this.options,
          retain: (hash: string) => {
            publication.frozen.push(hash);
            this.save(publication);
          },
        },
        task.threadId,
        selection,
        signal,
      );
      signal.throwIfAborted();
      if (!this.valid(task, caller) || this.read(task.id)?.sealed)
        return { ok: false, code: "forbidden" };
      record.artifacts = {
        taskId: task.id,
        sourceHostId: task.sourceHostId,
        parentThreadId: task.parentThreadId,
        hostId: task.request.hostId,
        threadId: task.threadId,
        attachments,
      };
      this.save(record);
      return { ok: true, data: record.artifacts };
    } catch {
      signal.throwIfAborted();
      return { ok: false, code: "unavailable" };
    } finally {
      this.pending.delete(task.id);
      this.discardPending(task.id);
    }
  }
  /** Seal text and export identity once; later target turns cannot change a delivered outcome. */
  seal(
    task: RemoteTask,
    outcome: {
      phase: "completed" | "failed";
      result: string;
      truncated: boolean;
      usage: RemoteTaskUsage;
    },
  ) {
    let record = this.read(task.id);
    if (record && !record.artifacts) return undefined;
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
    record.sealed ??= outcome;
    this.save(record);
    return { ...record.sealed, artifacts: record.artifacts };
  }
  outcome(id: string) {
    const record = this.read(id);
    return record?.sealed ? { ...record.sealed, artifacts: record.artifacts } : undefined;
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
