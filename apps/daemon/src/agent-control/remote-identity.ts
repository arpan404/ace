import { DeviceId } from "@ace/protocol";
import { createHash } from "node:crypto";
import type { RemoteTask } from "@ace/protocol";
export function validRemoteTask(task: RemoteTask, hostId: string): boolean {
  return (
    task.request.hostId === hostId &&
    task.sourceHostId !== hostId &&
    task.threadId === `remote-${task.id}` &&
    task.id ===
      createHash("sha256")
        .update(JSON.stringify([task.sourceHostId, task.parentThreadId, task.request.requestId]))
        .digest("hex") &&
    (!task.context ||
      (task.context.sourceHostId === task.sourceHostId &&
        task.context.sourceThreadId === task.parentThreadId &&
        task.context.attachments.reduce((sum, file) => sum + file.bytes, 0) <= 128 * 1024 * 1024 &&
        task.context.attachments.every((file) => file.bytes <= 32 * 1024 * 1024)))
  );
}
export const remoteContextOwner = DeviceId.parse("ace-remote-agent");
