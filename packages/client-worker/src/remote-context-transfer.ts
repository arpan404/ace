import type { ClientApi } from "@ace/client";
import { ClientError } from "@ace/client";
import type { RemoteContextChannel } from "@ace/client/remote-context-relay";
import type { RemoteTask, RemoteContextOperation, RemoteRelayTarget } from "@ace/protocol";
import type { z } from "zod";
/** Stream one immutable chunk at a time. Target verifies hashes before provider admission. */
export async function transferRemoteContext(
  task: RemoteTask,
  source: Pick<ClientApi, "request">,
  target: Pick<ClientApi, "request">,
  open: (relay: z.infer<typeof RemoteRelayTarget>) => Promise<RemoteContextChannel>,
  valid: () => boolean,
): Promise<void> {
  if (!task.context) return;
  const route = await target.request({ type: "delegation.remote.transport" });
  if (!route.ok || !route.relay)
    throw new ClientError("offline", "Remote device has no encrypted context relay");
  const channel = await open(route.relay);
  let sequence = 0;
  const request = async (operation: z.infer<typeof RemoteContextOperation>) => {
    if (!valid()) throw new ClientError("offline");
    const reply = await channel.request({
      type: "delegation.remote.context",
      requestId: `context-${task.id.slice(0, 16)}-${++sequence}`,
      task,
      operation,
    });
    if (!reply.ok || !reply.context || !valid())
      throw new ClientError("daemon", "Remote task context transfer unavailable");
    return reply.context;
  };
  try {
    await request({ op: "prepare" });
    for (const attachment of task.context.attachments) {
      const begun = await request({ op: "begin", sha256: attachment.sha256 });
      if (begun.kind !== "upload" || begun.bytes !== attachment.bytes)
        throw new ClientError("protocol", "Remote attachment reservation mismatch");
      let offset = begun.offset;
      while (offset < attachment.bytes) {
        if (!valid()) throw new ClientError("offline");
        const reply = await source.request({
          type: "delegation.remote.context",
          task,
          operation: { op: "read", sha256: attachment.sha256, offset },
        });
        const data = reply.context;
        if (
          !reply.ok ||
          data?.kind !== "attachment.data" ||
          data.offset !== offset ||
          data.sha256 !== attachment.sha256 ||
          data.bytes !== attachment.bytes ||
          data.variant !== "original"
        )
          throw new ClientError("protocol", "Source attachment scope mismatch");
        const written = await request({
          op: "chunk",
          uploadId: begun.uploadId,
          offset,
          data: data.data,
        });
        if (
          written.kind !== "upload" ||
          written.offset <= offset ||
          written.offset > attachment.bytes
        )
          throw new ClientError("protocol", "Remote attachment offset mismatch");
        offset = written.offset;
      }
      const committed = await request({ op: "commit", uploadId: begun.uploadId });
      if (
        committed.kind !== "attachment" ||
        committed.attachment.sha256 !== attachment.sha256 ||
        committed.attachment.bytes !== attachment.bytes
      )
        throw new ClientError("protocol", "Remote attachment hash mismatch");
    }
  } finally {
    channel.close();
  }
}
