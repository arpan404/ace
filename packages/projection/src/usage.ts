import type { UsageUpdated } from "@ace/protocol";

const part = (value: string) => `${value.length}:${value}`;
/** Length prefixes keep opaque native IDs and model names distinct without serializing payloads. */
export function usageSnapshotKey(
  usage: Pick<UsageUpdated, "agentId" | "usageScope" | "counterKey" | "model">,
): string {
  return (
    part(usage.agentId) +
    part(usage.usageScope ?? "agent") +
    part(usage.counterKey ?? "") +
    part(usage.model ?? "")
  );
}
