import { ModelClient, type ModelScope } from "@ace/client";
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
  /** The account the thread runs on: picked first, before its model. */
  scope: ModelScope;
  /** The catalog id picked on that account; the daemon resolves it to its canonical id. */
  model: string;
  mode: "local" | "worktree";
  /** Where a worktree starts; ignored for the local checkout. */
  baseBranch: string | undefined;
  effort: string | undefined;
  /** The faster tier to run on (`serviceTier`), when the person turned speed on. */
  serviceTier?: string | undefined;
  /** An explicit approval mode for this thread; the daemon's default when omitted. */
  permission?: PermissionMode | undefined;
  text: string;
  context?: MessageContext | undefined;
}

type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;
/** Provider, account (or ACP identity) and canonical model, as `ModelClient` resolved them. */
type Selection = Awaited<ReturnType<ModelClient["commandSelection"]>>;

/** The `thread.create` command for a request on the resolved selection. Pure. */
export function createPayload(
  request: Omit<CreateRequest, "scope" | "model">,
  selection: Selection,
): CreatePayload {
  const effort = AgentLaunchOptions.shape.effort.safeParse(request.effort);
  const tier = AgentLaunchOptions.shape.serviceTier.safeParse(request.serviceTier);
  const options = {
    ...(effort.success && effort.data ? { effort: effort.data } : {}),
    ...(tier.success && tier.data ? { serviceTier: tier.data } : {}),
  };
  return {
    type: "thread.create",
    workspaceId: WorkspaceId.parse(request.project),
    ...selection,
    mode: request.mode,
    ...(request.mode === "worktree" && request.baseBranch
      ? { baseBranch: request.baseBranch }
      : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(request.permission ? { permissionMode: request.permission } : {}),
    input: [{ type: "text", text: request.text }],
    ...(request.context ? { context: request.context } : {}),
  };
}

/**
 * Resolve the picked account's model through `ModelClient`, send `thread.create` with that
 * selection and open the thread the daemon's receipt names. The command carries the canonical
 * catalog id (OpenCode's `provider/model`), never a bare native id. The request is not queued
 * while offline: it fails at once, so the draft stays in the composer. A thread the daemon
 * started makes its provider the last used one, which the next thread starts on.
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
        const { scope, model, ...rest } = request;
        const selection = await new ModelClient(client).commandSelection(scope, model);
        const result = await runCommand(client, createPayload(rest, selection));
        if (!result.threadId) throw new Error("The daemon didn't say which thread it started.");
        rememberProvider(storage, selection.provider);
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
