import { ClientError } from "@ace/client";
import type { RemoteArtifactManifest, ContextResult, RemoteContextOperation } from "@ace/protocol";
import type { z } from "zod";
type Result = ContextResult["result"];
/** One acknowledged immutable chunk at a time, with hash verification in the receiving owner. */
export async function pumpRemoteAttachments(
  attachments: RemoteArtifactManifest["attachments"],
  read: (hash: string, offset: number) => Promise<Result | undefined>,
  write: (
    operation: Exclude<z.infer<typeof RemoteContextOperation>, { op: "read" }>,
  ) => Promise<Result | undefined>,
  valid: () => boolean,
): Promise<void> {
  for (const attachment of attachments) {
    if (!valid()) throw new ClientError("offline");
    const begun = await write({ op: "begin", sha256: attachment.sha256 });
    if (begun?.kind !== "upload" || begun.bytes !== attachment.bytes)
      throw new ClientError("protocol", "Attachment reservation mismatch");
    let offset = begun.offset;
    while (offset < attachment.bytes) {
      if (!valid()) throw new ClientError("offline");
      const data = await read(attachment.sha256, offset);
      if (
        data?.kind !== "attachment.data" ||
        data.offset !== offset ||
        data.sha256 !== attachment.sha256 ||
        data.bytes !== attachment.bytes ||
        data.variant !== "original"
      )
        throw new ClientError("protocol", "Attachment scope mismatch");
      const written = await write({
        op: "chunk",
        uploadId: begun.uploadId,
        offset,
        data: data.data,
      });
      if (
        written?.kind !== "upload" ||
        written.offset <= offset ||
        written.offset > attachment.bytes
      )
        throw new ClientError("protocol", "Attachment offset mismatch");
      offset = written.offset;
    }
    const committed = await write({ op: "commit", uploadId: begun.uploadId });
    if (
      committed?.kind !== "attachment" ||
      committed.attachment.sha256 !== attachment.sha256 ||
      committed.attachment.bytes !== attachment.bytes ||
      !valid()
    )
      throw new ClientError("protocol", "Attachment hash mismatch");
  }
}
