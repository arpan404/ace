import { FileError, type FilesService } from "@ace/files";
import type { FileOperation, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** Export identifiers carry source authority independently of a requested workspace/thread. */
export function fileExportSource(
  service: FilesService,
  store: Store | undefined,
  operation?: FileOperation,
): ThreadId | undefined {
  if (operation?.op === "artifact.download") return service.artifactSource(operation.artifactId);
  if (operation?.op !== "artifact.output" && operation?.op !== "artifact.raw") return;
  if (!store) throw new FileError("FORBIDDEN", "Export source unavailable");
  return operation.op === "artifact.output"
    ? store.outputInfo(operation.streamId).threadId
    : store.blobInfo(operation.blobRef).threadId;
}
