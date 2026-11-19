import type { ClientApi } from "@ace/client";
import type { ForgeBrowserOperation, ForgeBrowserResult } from "@ace/protocol";
import type { ForgeKind } from "@ace/protocol/forge";
import { actionErrorText, forgeErrorText, outcomeUncertain } from "@ace/ui-core";
import { CommandRefused, daemonErrorCode } from "@/lib/daemon-command.ts";

/** A forge read the daemon refused, keeping its code so views can tell offline from GitHub,
 * and the Git host it named, when it named one, so the sentence names that host's CLI. */
export class ForgeReadError extends Error {
  readonly code: string;
  readonly forge: ForgeKind | undefined;
  constructor(code: string, forge?: ForgeKind) {
    super(forgeErrorText(code, forge));
    this.name = "ForgeReadError";
    this.code = code;
    this.forge = forge;
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
  // The request schema reaches every Git host operation's: it loads with the first read, not
  // with each page that may read (20 KB gzip of the thread page).
  const { WorkspaceActionRequest } = await import("@ace/protocol/workspace-actions");
  const reply = await client.request(
    WorkspaceActionRequest.parse({ type: "workspace.request", requestId: "forge-read", operation }),
    { signal },
  );
  const forge = "repository" in operation ? operation.repository?.forge : undefined;
  if (reply.result.kind === "error") throw new ForgeReadError(reply.result.code, forge);
  if (reply.result.kind !== "forge") throw new ForgeReadError("forge_invalid_data", forge);
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
