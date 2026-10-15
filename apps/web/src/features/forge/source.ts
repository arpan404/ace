import type { ClientApi } from "@ace/client";
import {
  WorkspaceActionRequest,
  type ForgeBrowserOperation,
  type ForgeBrowserResult,
} from "@ace/protocol";
import { actionErrorText, outcomeUncertain } from "@ace/ui-core";
import { CommandRefused, daemonErrorCode } from "@/lib/daemon-command.ts";

/** A forge read the daemon refused, keeping its code so views can tell offline from GitHub. */
export class ForgeReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(actionErrorText(code));
    this.name = "ForgeReadError";
    this.code = code;
  }
}

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
  if (reply.result.kind === "error") throw new ForgeReadError(reply.result.code);
  if (reply.result.kind !== "forge") throw new ForgeReadError("forge_invalid_data");
  return reply.result.data;
}

/**
 * The code behind a failed forge read or write: the daemon's refusal, or the client's own
 * (offline, timeout, storage...). Undefined when nothing says what happened.
 */
export function failureCode(error: unknown): string | undefined {
  if (error instanceof CommandRefused || error instanceof ForgeReadError) return error.code;
  const code = daemonErrorCode(error);
  return code === "unknown" ? undefined : code;
}

/** What a failed write means: its sentence, and whether it may still have happened. */
export function writeFailure(error: unknown): { text: string; uncertain: boolean } {
  const code = failureCode(error);
  const uncertain = outcomeUncertain(code);
  return {
    text: code ? actionErrorText(code) : actionErrorText("action_outcome_uncertain"),
    uncertain,
  };
}
