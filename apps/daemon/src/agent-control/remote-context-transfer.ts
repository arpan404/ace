import { z } from "zod";
import {
  CommandId,
  type ClientMessage,
  RemoteTask,
  type RemoteDelegationResult,
  MessageContext,
} from "@ace/protocol";
import type { ServerOptions } from "../server-options.ts";
import { validRemoteTask, remoteContextOwner } from "./remote-identity.ts";
const Reservation = z.object({
  task: RemoteTask,
  draftId: z.string(),
  uploads: z.record(z.string(), z.object({ hash: z.string(), committed: z.boolean() })),
});
/** One bounded serial queue owner per daemon; never shared between daemon instances. */
export class RemoteContextTransfers {
  private pending = new Map<string, Promise<unknown>>();
  private count = 0;
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.count >= 64) throw new Error("Remote context busy");
    this.count++;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.pending.set(key, next);
    try {
      return await next;
    } finally {
      this.count--;
      if (this.pending.get(key) === next) this.pending.delete(key);
    }
  }
}
function table(options: ServerOptions) {
  options.store.atomic((db) =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS remote_agent_context(id TEXT PRIMARY KEY,record JSON NOT NULL)",
    ),
  );
}
function read(options: ServerOptions, id: string) {
  table(options);
  const row = options.store.atomic((db) =>
    db.prepare("SELECT record FROM remote_agent_context WHERE id=?").get(id),
  );
  return row ? Reservation.parse(JSON.parse(z.string().parse(row.record))) : undefined;
}
function save(options: ServerOptions, id: string, value: z.infer<typeof Reservation>) {
  options.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO remote_agent_context VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(id, JSON.stringify(value)),
  );
}
export function incomingRemoteContext(
  options: ServerOptions,
  task: RemoteTask,
): MessageContext | undefined {
  if (!task.context) return;
  const record = read(options, task.id);
  if (
    !record ||
    JSON.stringify(record.task.context) !== JSON.stringify(task.context) ||
    task.context.attachments.some(
      (file) =>
        !Object.values(record.uploads).some(
          (upload) => upload.hash === file.sha256 && upload.committed,
        ),
    )
  )
    throw new Error("remote_context_incomplete");
  if (!task.context.attachments.length) return;
  return MessageContext.parse({
    draftId: record.draftId,
    attachments: task.context.attachments.map((file) => ({ sha256: file.sha256 })),
  });
}
/** Task-scoped immutable context over the existing authenticated files relay. */
export async function remoteContextTransfer(
  options: ServerOptions,
  message: Extract<ClientMessage, { type: "delegation.remote.context" }>,
  allowed: (thread?: string) => boolean,
): Promise<RemoteDelegationResult> {
  const base = { type: "delegation.broker.result" as const, requestId: message.requestId };
  const transfers = (options.remoteContextTransfers ??= new RemoteContextTransfers());
  try {
    return await transfers.run(message.task.id, async (): Promise<RemoteDelegationResult> => {
      const { task, operation: op } = message;
      const context = options.context;
      const fail = (
        error: NonNullable<RemoteDelegationResult["error"]>,
      ): RemoteDelegationResult => ({ ...base, ok: false, error });
      if (!context || !allowed()) return fail("forbidden");
      if (op.op === "read") {
        const owned = options.agentControl?.remote.journal.get(task.id);
        if (
          !owned ||
          owned.sourceHostId !== options.hostId ||
          !allowed(owned.parentThreadId) ||
          owned.phase === "cancelling" ||
          owned.phase === "cancelled" ||
          !owned.context?.attachments.some((file) => file.sha256 === op.sha256)
        )
          return fail("forbidden");
        const reply = await context.handle(
          remoteContextOwner,
          {
            type: "context.request",
            requestId: message.requestId,
            operation: {
              op: "attachment.read",
              threadId: owned.parentThreadId,
              sha256: op.sha256,
              variant: "original",
              offset: op.offset,
              limit: 65536,
            },
          },
          () => allowed(owned.parentThreadId),
        );
        return { ...base, ok: reply.result.kind !== "error", context: reply.result };
      }
      if (
        !validRemoteTask(task, options.hostId) ||
        !task.context ||
        options.store.commandReceipt(
          CommandId.parse(`remote-create:${task.id}`),
          remoteContextOwner,
        )?.error === "remote_task_cancelled"
      )
        return fail("invalid");
      const transferAllowed = () =>
        allowed() &&
        options.store.commandReceipt(
          CommandId.parse(`remote-create:${task.id}`),
          remoteContextOwner,
        )?.error !== "remote_task_cancelled";
      let record = read(options, task.id);
      if (
        record &&
        JSON.stringify([record.task.request, record.task.context, record.task.permissionMode]) !==
          JSON.stringify([task.request, task.context, task.permissionMode])
      )
        return fail("invalid");
      if (op.op === "prepare") {
        if (record && !options.store.getThread(task.threadId)) {
          try {
            if (!context.draftWorkspace) return fail("not_ready");
            await context.draftWorkspace(remoteContextOwner, record.draftId);
          } catch {
            record = undefined;
          }
        }
        if (!record) {
          const count = options.store.atomic(
            (db) =>
              z
                .object({ count: z.number() })
                .parse(db.prepare("SELECT COUNT(*) AS count FROM remote_agent_context").get())
                .count,
          );
          if (count >= 10000) return fail("busy");
          const reply = await context.handle(
            remoteContextOwner,
            {
              type: "context.request",
              requestId: message.requestId,
              operation: { op: "draft.create", workspaceId: task.request.workspaceId },
            },
            transferAllowed,
          );
          if (reply.result.kind !== "draft") return { ...base, ok: false, context: reply.result };
          record = { task, draftId: reply.result.draftId, uploads: {} };
          save(options, task.id, record);
        }
        return { ...base, ok: true, context: { kind: "draft", draftId: record.draftId } };
      }
      if (!record) return fail("not_ready");
      const state = record;
      let operation: import("@ace/protocol").ContextOperation;
      if (op.op === "begin") {
        const attachment = task.context.attachments.find((file) => file.sha256 === op.sha256);
        if (!attachment) return fail("forbidden");
        const existing = Object.entries(state.uploads).find(
          ([, upload]) => upload.hash === op.sha256,
        );
        if (existing) {
          const status = await context.handle(
            remoteContextOwner,
            {
              type: "context.request",
              requestId: message.requestId,
              operation: { op: "upload.status", uploadId: existing[0] },
            },
            transferAllowed,
          );
          if (status.result.kind === "error") delete state.uploads[existing[0]];
        }
        operation =
          existing && state.uploads[existing[0]]
            ? { op: "upload.status", uploadId: existing[0] }
            : {
                op: "draft.upload.begin",
                draftId: state.draftId,
                sha256: attachment.sha256,
                bytes: attachment.bytes,
                name: attachment.name,
                mimeType: attachment.mimeType,
              };
      } else {
        if (!state.uploads[op.uploadId]) return fail("forbidden");
        operation =
          op.op === "chunk"
            ? { op: "upload.chunk", uploadId: op.uploadId, offset: op.offset, data: op.data }
            : { op: "upload.commit", uploadId: op.uploadId };
      }
      const reply = await context.handle(
        remoteContextOwner,
        { type: "context.request", requestId: message.requestId, operation },
        transferAllowed,
      );
      if (!allowed()) return fail("forbidden");
      if (op.op === "begin" && reply.result.kind === "upload")
        state.uploads[reply.result.uploadId] ??= { hash: op.sha256, committed: false };
      if (op.op === "commit" && reply.result.kind === "attachment") {
        const upload = state.uploads[op.uploadId];
        if (!upload || upload.hash !== reply.result.attachment.sha256) return fail("invalid");
        upload.committed = true;
      }
      save(options, task.id, state);
      return { ...base, ok: reply.result.kind !== "error", context: reply.result };
    });
  } catch {
    return { ...base, ok: false, error: "not_ready" };
  }
}
