import { ClientError } from "@ace/client";
import { useClient } from "@ace/client-react";
import { actionErrorText } from "@ace/ui-core";
import type { ForgeRepository } from "@ace/protocol";

/**
 * Unlinks one pull request from the thread: the pull request stays on GitHub, only the link
 * goes. The thread's details arrive live, so the lists that read them need no refresh.
 */
export function useUnlinkPr(threadId: string) {
  const client = useClient();
  return async (pr: { number: number; repo: ForgeRepository }) => {
    const result = await client.command({
      type: "forge.pr.unlink",
      threadId,
      number: pr.number,
      repo: pr.repo,
    });
    if (!result.ok) throw new Error(result.error ?? "failed");
  };
}

/** Why an unlink failed, in words. */
export function unlinkFailureText(error: unknown): string {
  if (error instanceof ClientError)
    return actionErrorText(error.code === "daemon" ? error.message : error.code);
  return actionErrorText(error instanceof Error ? error.message : undefined);
}
