import { createHash } from "node:crypto";
export function controlCommandId(thread: string, request: string, operation: string) {
  return `agent-${createHash("sha256")
    .update(JSON.stringify([thread, request, operation]))
    .digest("hex")}`;
}
