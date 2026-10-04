import { useClient } from "@ace/client-react";
import {
  AgentLaunchOptions,
  WorkspaceId,
  type CommandPayload,
  type MessageContext,
  type PermissionMode,
} from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useLayout } from "@/lib/layout.tsx";
import { rememberProvider } from "@/lib/provider-statuses.ts";

export interface CreateRequest {
  project: string;
  provider: Extract<CommandPayload, { type: "thread.create" }>["provider"];
  model: string | undefined;
  /** The account (provider instance) to run on; the daemon picks one when omitted. */
  account: string | undefined;
  mode: "local" | "worktree";
  /** Where a worktree starts; ignored for the local checkout. */
  baseBranch: string | undefined;
  effort: string | undefined;
  /** An explicit approval mode for this thread; the daemon's default when omitted. */
  permission?: PermissionMode | undefined;
  text: string;
  context?: MessageContext | undefined;
}

type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;

/** The `thread.create` command for a request. Pure. */
export function createPayload(request: CreateRequest): CreatePayload {
  const effort = AgentLaunchOptions.shape.effort.safeParse(request.effort);
  return {
    type: "thread.create",
    workspaceId: WorkspaceId.parse(request.project),
    provider: request.provider,
    mode: request.mode,
    ...(request.model ? { model: request.model } : {}),
    ...(request.account ? { accountId: request.account } : {}),
    ...(request.mode === "worktree" && request.baseBranch
      ? { baseBranch: request.baseBranch }
      : {}),
    ...(effort.success && effort.data ? { options: { effort: effort.data } } : {}),
    ...(request.permission ? { permissionMode: request.permission } : {}),
    input: [{ type: "text", text: request.text }],
    ...(request.context ? { context: request.context } : {}),
  };
}

/**
 * Send `thread.create` and open the thread the daemon's receipt names. The request is not
 * queued while offline: it fails at once, so the draft stays in the composer. A thread the
 * daemon started makes its provider the last used one, which the next thread starts on.
 */
export function useCreateThread(): {
  /** Resolves false when the daemon didn't create the thread. */
  create(request: CreateRequest): Promise<boolean>;
  sending: boolean;
  error: string | undefined;
} {
  const client = useClient();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const create = useCallback(
    async (request: CreateRequest) => {
      setError(undefined);
      setSending(true);
      try {
        const result = await runCommand(client, createPayload(request));
        if (!result.threadId) throw new Error("The daemon didn't say which thread it started.");
        rememberProvider(storage, request.provider);
        void navigate({ to: "/t/$threadId", params: { threadId: result.threadId } });
        return true;
      } catch (failure) {
        setError(`The daemon didn't start the thread. ${failureMessage(failure)}`);
        return false;
      } finally {
        setSending(false);
      }
    },
    [client, navigate, storage],
  );
  return { create, sending, error };
}
