import { z } from "zod";
import {
  RemoteArtifactManifest,
  ThreadId,
  type ClientMessage,
  type RemoteTask,
  type RemoteDelegationResult,
} from "@ace/protocol";
import type { ServerOptions } from "../server-options.ts";
import { RemoteContextTransfers } from "./remote-context-transfer.ts";
import { remoteContextOwner } from "./remote-identity.ts";
import type { Store } from "../store.ts";
const ImportRecord = z.object({
  abandoned: z.boolean().default(false),
  artifacts: RemoteArtifactManifest,
  uploads: z.record(z.string(), z.object({ hash: z.string(), committed: z.boolean() })),
});
/** Originating thread owns returned bytes; provenance stays independent from attachment aliases. */
export class RemoteReturns {
  private store: Store;
  private pending: Promise<void> | undefined;
  private cleanupCursor = "";
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS remote_agent_returns(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,record JSON NOT NULL)",
      ),
    );
  }
  read(id: string) {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT record FROM remote_agent_returns WHERE id=?").get(id),
    );
    return row ? ImportRecord.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  save(record: z.infer<typeof ImportRecord>) {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO remote_agent_returns VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        )
        .run(record.artifacts.taskId, record.artifacts.parentThreadId, JSON.stringify(record)),
    );
  }
  abandon(task: RemoteTask, context: ServerOptions["context"], onError: (error: unknown) => void) {
    const record = this.read(task.id);
    if (!record) return;
    record.abandoned = true;
    this.save(record);
    if (context) void this.cleanup(context, onError);
  }
  cleanup(context: NonNullable<ServerOptions["context"]>, onError: (error: unknown) => void) {
    if (this.pending) return this.pending;
    this.pending = this.drain(context, onError)
      .catch(onError)
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async drain(
    context: NonNullable<ServerOptions["context"]>,
    onError: (error: unknown) => void,
  ) {
    const select = (after: string) =>
      this.store.atomic((db) =>
        db
          .prepare(
            "SELECT id FROM remote_agent_returns WHERE id>? AND json_extract(record,'$.abandoned')=1 AND json_extract(record,'$.uploads')!='{}' ORDER BY id LIMIT 32",
          )
          .all(after),
      );
    let rows = select(this.cleanupCursor);
    if (!rows.length && this.cleanupCursor) rows = select("");
    this.cleanupCursor = rows.length ? z.string().parse(rows.at(-1)?.id) : "";
    for (const row of rows) {
      const id = z.string().parse(row.id);
      const record = this.read(id);
      if (!record?.abandoned) continue;
      const originalIds = Object.keys(record.uploads);
      for (const [uploadId, upload] of Object.entries(record.uploads)) {
        if (upload.committed) {
          delete record.uploads[uploadId];
          continue;
        }
        try {
          const reply = await context.handle(remoteContextOwner, {
            type: "context.request",
            requestId: `cancel-${uploadId}`,
            operation: { op: "upload.cancel", uploadId },
          });
          if (reply.result.kind !== "error" || reply.result.code === "not_found")
            delete record.uploads[uploadId];
        } catch (error) {
          onError(error);
        }
      }
      // Reload before saving: a late upload.begin can add another owned reservation while cancellation awaits.
      const current = this.read(id);
      if (!current?.abandoned) continue;
      for (const uploadId of originalIds) delete current.uploads[uploadId];
      for (const [uploadId, upload] of Object.entries(record.uploads))
        current.uploads[uploadId] = upload;
      this.save(current);
    }
  }
  validManifest(task: RemoteTask, manifest: RemoteArtifactManifest) {
    return (
      manifest.taskId === task.id &&
      manifest.sourceHostId === task.sourceHostId &&
      manifest.parentThreadId === task.parentThreadId &&
      manifest.hostId === task.request.hostId &&
      manifest.threadId === task.threadId &&
      manifest.attachments.every((file) => file.bytes <= 32 * 1024 * 1024) &&
      manifest.attachments.reduce((n, file) => n + file.bytes, 0) <= 128 * 1024 * 1024 &&
      new Set(manifest.attachments.map((file) => file.sha256)).size === manifest.attachments.length
    );
  }
  ready(task: RemoteTask, manifest: RemoteArtifactManifest) {
    if (!this.validManifest(task, manifest)) return false;
    const record = this.read(task.id);
    if (!record) return !manifest.attachments.length;
    return (
      !record.abandoned &&
      JSON.stringify(record.artifacts) === JSON.stringify(manifest) &&
      manifest.attachments.every((file) =>
        Object.values(record.uploads).some(
          (upload) => upload.hash === file.sha256 && upload.committed,
        ),
      )
    );
  }
  retains(parent: string, hash: string) {
    return this.store
      .atomic((db) =>
        db
          .prepare("SELECT record FROM remote_agent_returns WHERE parent_id=? LIMIT 10000")
          .all(parent),
      )
      .some((row) => {
        const record = ImportRecord.parse(JSON.parse(z.string().parse(row.record)));
        return (
          !record.abandoned && record.artifacts.attachments.some((file) => file.sha256 === hash)
        );
      });
  }
}
export async function remoteReturnTransfer(
  options: ServerOptions,
  message: Extract<ClientMessage, { type: "delegation.broker.return" }>,
  session: string,
  allowed: (thread?: string) => boolean,
): Promise<RemoteDelegationResult> {
  const base = { type: "delegation.broker.result" as const, requestId: message.requestId };
  const fail = (error: NonNullable<RemoteDelegationResult["error"]>): RemoteDelegationResult => ({
    ...base,
    ok: false,
    error,
  });
  const transfers = (options.remoteContextTransfers ??= new RemoteContextTransfers());
  try {
    return await transfers.run(`return:${message.artifacts.taskId}`, async () => {
      const remote = options.agentControl?.remote;
      const returns = options.agentControl?.returns;
      const context = options.context;
      const task = remote?.returnTask(session, message.lease, message.artifacts.taskId);
      if (
        !task ||
        !returns ||
        !context ||
        !allowed(task.parentThreadId) ||
        !returns.validManifest(task, message.artifacts)
      )
        return fail("forbidden");
      const valid = () =>
        allowed(task.parentThreadId) && !!remote?.returnTask(session, message.lease, task.id);
      let record = returns.read(task.id);
      if (record && JSON.stringify(record.artifacts) !== JSON.stringify(message.artifacts))
        return fail("invalid");
      const op = message.operation;
      if (op.op === "prepare") {
        if (!record) {
          record = { artifacts: message.artifacts, uploads: {}, abandoned: false };
          returns.save(record);
        }
        return { ...base, ok: true, artifacts: record.artifacts };
      }
      if (!record || record.abandoned) return fail("not_ready");
      let operation: import("@ace/protocol").ContextOperation;
      if (op.op === "begin") {
        const file = record.artifacts.attachments.find(
          (candidate) => candidate.sha256 === op.sha256,
        );
        if (!file) return fail("forbidden");
        const existing = Object.entries(record.uploads).find(
          ([, upload]) => upload.hash === file.sha256,
        );
        if (existing) {
          const status = await context.handle(
            remoteContextOwner,
            {
              type: "context.request",
              requestId: message.requestId,
              operation: { op: "upload.status", uploadId: existing[0] },
            },
            valid,
          );
          if (status.result.kind !== "error") return { ...base, ok: true, context: status.result };
          delete record.uploads[existing[0]];
        }
        operation = {
          op: "upload.begin",
          threadId: task.parentThreadId,
          sha256: file.sha256,
          bytes: file.bytes,
          name: file.name,
          mimeType: file.mimeType,
        };
      } else {
        if (!record.uploads[op.uploadId]) return fail("forbidden");
        operation =
          op.op === "chunk"
            ? { op: "upload.chunk", uploadId: op.uploadId, offset: op.offset, data: op.data }
            : { op: "upload.commit", uploadId: op.uploadId };
      }
      const reply = await context.handle(
        remoteContextOwner,
        { type: "context.request", requestId: message.requestId, operation },
        valid,
      );
      if (!valid()) {
        if (op.op === "begin" && reply.result.kind === "upload") {
          const owned = returns.read(task.id) ?? record;
          const phase = remote?.journal.get(task.id)?.phase;
          owned.abandoned ||= phase === "cancelling" || phase === "cancelled";
          owned.uploads[reply.result.uploadId] = { hash: op.sha256, committed: false };
          returns.save(owned);
          // A lost broker lease is resumable; only Stop abandons the immutable selection.
          if (owned.abandoned) await returns.cleanup(context, () => {});
        }
        return fail("forbidden");
      }
      if (op.op === "begin" && reply.result.kind === "upload")
        record.uploads[reply.result.uploadId] = { hash: op.sha256, committed: false };
      if (op.op === "commit" && reply.result.kind === "attachment") {
        const upload = record.uploads[op.uploadId];
        if (!upload || upload.hash !== reply.result.attachment.sha256) return fail("invalid");
        upload.committed = true;
      }
      returns.save(record);
      return { ...base, ok: reply.result.kind !== "error", context: reply.result };
    });
  } catch {
    return fail("not_ready");
  }
}
/** Output reads use the target's sealed publication, never an agent-supplied path. */
export async function remoteOutputRead(
  options: ServerOptions,
  message: Extract<ClientMessage, { type: "delegation.remote.output" }>,
  allowed: (thread?: string) => boolean,
): Promise<RemoteDelegationResult> {
  const base = { type: "delegation.broker.result" as const, requestId: message.requestId };
  const manifest = options.agentControl?.publications.manifest(message.taskId);
  if (
    !manifest ||
    !options.context ||
    manifest.hostId !== options.hostId ||
    !allowed(manifest.threadId) ||
    !manifest.attachments.some((file) => file.sha256 === message.operation.sha256)
  )
    return { ...base, ok: false, error: "forbidden" };
  const reply = await options.context.handle(
    remoteContextOwner,
    {
      type: "context.request",
      requestId: message.requestId,
      operation: {
        op: "attachment.read",
        threadId: ThreadId.parse(manifest.threadId),
        sha256: message.operation.sha256,
        variant: "original",
        offset: message.operation.offset,
        limit: 65536,
      },
    },
    () => allowed(manifest.threadId),
  );
  return { ...base, ok: reply.result.kind !== "error", context: reply.result };
}
