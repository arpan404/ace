import { ClientError } from "@ace/client";
import { actionErrorText } from "@ace/ui-core";
import { WorkspaceError } from "../sources/workspace-source.ts";

/** The connection failures that have their own sentence; the rest get the general one. */
const clientCodes: Partial<Record<ClientError["code"], string>> = {
  offline: "offline",
  timeout: "timeout",
  not_dispatched: "action_not_dispatched",
};

/** The refusal code behind a failed git or forge action, when it has one. */
export function gitFailureCode(error: unknown): string | undefined {
  if (error instanceof WorkspaceError) return error.code;
  // A daemon error reply carries the daemon's own refusal code as its message.
  if (error instanceof ClientError)
    return error.code === "daemon" ? error.message : clientCodes[error.code];
  return undefined;
}

/** Only classified failures supply detail; unexpected errors get safe recovery text. */
export const gitFailureText = (error: unknown): string => actionErrorText(gitFailureCode(error));
