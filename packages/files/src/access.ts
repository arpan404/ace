import type { FileOperation } from "@ace/protocol";

const reads = new Set<FileOperation["op"]>([
  "list",
  "stat",
  "download",
  "artifact.download",
  "archive.preview",
  "archive.download",
  "artifacts.list",
  "trash.list",
  "artifact.output",
  "artifact.raw",
  "artifact.support",
]);

/** Service and both transports enforce the same capability for each operation. */
export function fileCapability(operation: FileOperation): "files.read" | "files.write" {
  return reads.has(operation.op) ? "files.read" : "files.write";
}
