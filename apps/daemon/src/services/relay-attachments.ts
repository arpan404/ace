import { attachmentChannel } from "@ace/files";
import type { HostChannel } from "@ace/relay";
import type { DeviceId } from "@ace/protocol";
import type { ServerOptions } from "../server-options.ts";

/**
 * Attachment streaming on a relay channel: credits bound each stream to one 64 KiB frame, so a
 * backlog from other traffic on a slow link waits its turn instead of failing the image.
 */
export function relayAttachments(
  service: ServerOptions["context"] | undefined,
  channel: HostChannel,
  device: DeviceId,
  authorize: (scope: "read" | "operate" | "admin") => boolean,
  threadAccess: (thread: string) => boolean,
) {
  if (!service?.downloadAttachment) return undefined;
  const download = service.downloadAttachment.bind(service);
  return attachmentChannel({
    async resolve(thread, hash, maxBytes) {
      const authorized = () => authorize("read") && threadAccess(thread);
      if (!authorized()) throw new Error("Thread attachment unavailable");
      const file = await download(device, thread, hash, maxBytes, authorized);
      return { download: file, authorized };
    },
    async send(message) {
      await channel.send(message);
    },
    async binary(bytes) {
      await channel.sendBinary(bytes);
    },
  });
}
