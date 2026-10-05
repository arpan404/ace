import { useClient } from "@ace/client-react";
import {
  AgentLaunchOptions,
  WorkspaceId,
  type CommandPayload,
  type MessageContext,
  type PermissionMode,
} from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { provisionalTitle } from "@ace/ui-core";
import { useCallback, useState } from "react";
import { rememberTitle } from "@/features/thread/index.ts";
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
  /** The faster tier to run on (`serviceTier`), when the person turned speed on. */
  serviceTier?: string | undefined;
  /** An explicit approval mode for this thread; the daemon's default when omitted. */
  permission?: PermissionMode | undefined;
  text: string;
  context?: MessageContext | undefined;
}

type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;

/** The `thread.create` command for a request. Pure. */
export function createPayload(request: CreateRequest): CreatePayload {
  const effort = AgentLaunchOptions.shape.effort.safeParse(request.effort);
  const tier = AgentLaunchOptions.shape.serviceTier.safeParse(request.serviceTier);
  const options = {
    ...(effort.success && effort.data ? { effort: effort.data } : {}),
    ...(tier.success && tier.data ? { serviceTier: tier.data } : {}),
  };
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
    ...(Object.keys(options).length ? { options } : {}),
    ...(request.permission ? { permissionMode: request.permission } : {}),
    input: [{ type: "text", text: request.text }],
    ...(request.context ? { context: request.context } : {}),
  };
}

/** Where a new thread shows until the daemon has started it: its command's own route. */
export const pendingThreadId = (commandId: string) => `pending:${commandId}`;

/**
 * Start a thread the way a message is sent (UX audit SY-2, SY-4): `thread.create` goes into the
 * client's durable outbox under a command id made here, and the thread opens at once on its
 * pending route (`/t/pending:<commandId>`) with the person's message as its first bubble. The
 * pending view moves to the real thread when the daemon's receipt names it. Offline or slow is
 * never a failure, and a retry reuses nothing, so one Enter can never start two threads.
 */
export function useCreateThread(): {
  /** Resolves false only when this device couldn't save the request. */
  create(request: CreateRequest): Promise<boolean>;
  error: string | undefined;
} {
  const client = useClient();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const [error, setError] = useState<string>();

  const create = useCallback(
    async (request: CreateRequest) => {
      setError(undefined);
      const commandId = crypto.randomUUID();
      const payload = createPayload(request);
      // Its header and row read the provisional title at once (the daemon titles it the same way).
      rememberTitle(commandId, provisionalTitle(payload.input));
      // The pending entry is visible before the outbox has saved it: open it now.
      const saved = client.enqueue(payload, commandId);
      rememberProvider(storage, request.provider);
      void navigate({ to: "/t/$threadId", params: { threadId: pendingThreadId(commandId) } });
      try {
        await saved;
        return true;
      } catch {
        setError("This device couldn't save the new thread. Try again.");
        return false;
      }
    },
    [client, navigate, storage],
  );
  return { create, error };
}
