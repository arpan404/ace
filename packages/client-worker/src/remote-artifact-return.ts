import { pumpRemoteAttachments } from "./remote-attachment-pump.ts";
import { ClientError, type ClientApi } from "@ace/client";
import type { RemoteContextChannel } from "@ace/client/remote-context-relay";
import type { RemoteTask, RemoteArtifactManifest, RemoteRelayTarget } from "@ace/protocol";
import type { z } from "zod";
/** Explicit selected outputs become source-thread attachments, never workspace overwrites. */
export async function returnRemoteArtifacts(
  task: RemoteTask,
  artifacts: RemoteArtifactManifest,
  lease: string,
  source: Pick<ClientApi, "request">,
  target: Pick<ClientApi, "request">,
  open: (relay: z.infer<typeof RemoteRelayTarget>) => Promise<RemoteContextChannel>,
  valid: () => boolean,
) {
  if (!artifacts.attachments.length) return;
  const route = await target.request({ type: "delegation.remote.transport" });
  if (!route.ok || !route.relay) throw new ClientError("offline", "Output relay unavailable");
  const channel = await open(route.relay);
  let sequence = 0;
  const write = async (operation: Parameters<Parameters<typeof pumpRemoteAttachments>[2]>[0]) => {
    if (!valid()) throw new ClientError("offline");
    const reply = await source.request({
      type: "delegation.broker.return",
      lease,
      artifacts,
      operation,
    });
    if (!reply.ok || !valid())
      throw new ClientError("offline", "Source output admission unavailable");
    return reply.context;
  };
  try {
    await write({ op: "prepare" });
    await pumpRemoteAttachments(
      artifacts.attachments,
      async (sha256, offset) => {
        const reply = await channel.request({
          type: "delegation.remote.output",
          requestId: `return-${task.id.slice(0, 16)}-${++sequence}`,
          taskId: task.id,
          operation: { op: "read", sha256, offset },
        });
        if (!reply.ok || !valid()) throw new ClientError("offline", "Published output unavailable");
        return reply.context;
      },
      write,
      valid,
    );
  } finally {
    channel.close();
  }
}
