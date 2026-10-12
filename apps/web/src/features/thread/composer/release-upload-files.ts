import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";

/** Release only this submission's uploaded files. Shared or admitted references stay intact. */
export async function releaseUploadFiles(
  client: ClientApi,
  threadId: string,
  hashes: readonly string[],
  retained: () => ReadonlySet<string>,
): Promise<boolean> {
  try {
    for (const sha256 of new Set(hashes)) {
      if (retained().has(sha256)) continue;
      const { result } = await client.request({
        type: "context.request",
        operation: { op: "attachment.release", threadId: ThreadId.parse(threadId), sha256 },
      });
      // The daemon also protects attachments already used by accepted work.
      if (result.kind !== "ok" && !(result.kind === "error" && result.code === "busy"))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
