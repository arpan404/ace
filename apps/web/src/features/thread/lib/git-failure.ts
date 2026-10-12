import { actionErrorText } from "@ace/ui-core";
import { WorkspaceError } from "../sources/workspace-source.ts";

/** Only classified workspace failures supply detail; unexpected errors get safe recovery text. */
export const gitFailureText = (error: unknown): string =>
  actionErrorText(error instanceof WorkspaceError ? error.code : undefined);
