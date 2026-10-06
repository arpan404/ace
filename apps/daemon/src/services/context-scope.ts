import type { ContextOperation } from "@ace/protocol";

export function contextScope(operation: ContextOperation): "read" | "operate" {
  const op = operation.op;
  return op === "attachment.list" ||
    op === "attachment.read" ||
    op === "upload.status" ||
    op.startsWith("mention.") ||
    op === "draft.mention.complete"
    ? "read"
    : "operate";
}
