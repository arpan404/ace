import type { ClientApi } from "@ace/client";
import {
  WorkspaceActionRequest,
  type ForgeBrowserOperation,
  type ForgeBrowserResult,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";

export async function readForge(
  client: ClientApi,
  operation: ForgeBrowserOperation extends infer Operation
    ? Operation extends { workspaceId: string }
      ? Omit<Operation, "workspaceId"> & { workspaceId: string }
      : never
    : never,
  signal: AbortSignal,
): Promise<ForgeBrowserResult> {
  const reply = await client.request(
    WorkspaceActionRequest.parse({ type: "workspace.request", requestId: "forge-read", operation }),
    { signal },
  );
  if (reply.result.kind === "error") throw new Error(forgeError(reply.result.code));
  if (reply.result.kind !== "forge")
    throw new Error("The repository response was incomplete. Refresh to try again.");
  return reply.result.data;
}
export function forgeError(code: string): string {
  const messages: Record<string, string> = {
    forge_status_unavailable: "GitHub accepted the action. Refresh to load its current status.",
    forge_action_reconciled:
      "The previous action is reconciled. Review the current PR before making another change.",
    forge_write_pending: "An action is still running for this PR. Refresh before continuing.",
    forge_write_uncertain:
      "GitHub may have accepted the action. Refresh to reconcile it before making another change.",
    action_outcome_uncertain:
      "GitHub may have accepted this action. Check its result before retrying; your edit is retained.",
    forge_cli: "GitHub is unavailable. Check your connection and installed gh CLI, then refresh.",
    forge_forbidden:
      "Your GitHub account cannot perform this action or access this repository. Check gh login and permissions.",
    forge_not_found: "This repository or pull request is missing or inaccessible.",
    forge_rate_limit: "GitHub's rate limit was reached. Wait before refreshing.",
    forge_limit:
      "GitHub returned more data than ace can safely display. Open GitHub for the complete resource.",
    forge_conflict:
      "GitHub could not apply the action, or the pull request changed. Refresh and review its current state.",
    forge_unsupported: "This forge or GitHub host does not support the requested action.",
    forge_invalid_data: "GitHub returned an unreadable response. Refresh to try again.",
  };
  return messages[code] ?? actionErrorText(code);
}
