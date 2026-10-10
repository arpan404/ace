import { pumpRemoteAttachments } from "./remote-attachment-pump.ts";
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
    await pumpRemoteAttachments(
      task.context.attachments,
      async (sha256, offset) => {
        const reply = await source.request({
          type: "delegation.remote.context",
          task,
          operation: { op: "read", sha256, offset },
        });
        if (!reply.ok) throw new ClientError("protocol", "Source attachment unavailable");
        return reply.context;
      },
      request,
      valid,
    );
  } finally {
    channel.close();
  }
}
