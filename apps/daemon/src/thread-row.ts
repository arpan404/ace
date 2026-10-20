import type { SQLOutputValue } from "node:sqlite";
import {
  ProviderGoal,
  Thread,
  ThreadClientFields,
  ThreadTransitionView,
  ThreadProviderMetadata,
} from "@ace/protocol";

/** Decode a materialized thread row; provider and client extensions retain their schemas. */
export function decodeThreadRow(row: Record<string, SQLOutputValue>): Thread {
  const metadata =
    row.provider_metadata == null
      ? {}
      : Thread.pick({ backend: true }).parse(JSON.parse(String(row.provider_metadata)));
  return Thread.parse({
    ...(row.provider === "cursor" && metadata.backend !== "cursor-sdk"
      ? {
          continuation: {
            state: "read_only",
            reason: "cursor_cli_retired",
            actionId: "thread.continue_new",
          },
        }
      : {}),
    ...(row.client == null ? {} : ThreadClientFields.parse(JSON.parse(String(row.client)))),
    ...(row.transitions == null
      ? {}
      : ThreadTransitionView.parse(JSON.parse(String(row.transitions)))),
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    provider: row.provider,
    ...(row.provider_metadata == null
      ? {}
      : Thread.pick({
          backend: true,
          capabilities: true,
          handoff: true,
          permission: true,
          titleSource: true,
          queue: true,
        }).parse(JSON.parse(String(row.provider_metadata)))),
    ...storedGoal(row.provider_metadata),
    ...(row.acp == null ? {} : ThreadProviderMetadata.parse(JSON.parse(String(row.acp)))),
    status: JSON.parse(String(row.status)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.imported == null ? {} : { imported: JSON.parse(String(row.imported)) }),
    ...(row.root_agent_id === null ? {} : { rootAgentId: row.root_agent_id }),
  });
}

/** A stored goal the current schema can't read is dropped: the provider's next update restores it. */
function storedGoal(metadata: SQLOutputValue | undefined): { goal?: ProviderGoal } {
  if (metadata == null) return {};
  const value: unknown = JSON.parse(String(metadata));
  const goal = ProviderGoal.safeParse(
    typeof value === "object" && value !== null && "goal" in value ? value.goal : undefined,
  );
  return goal.success ? { goal: goal.data } : {};
}
