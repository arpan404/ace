import { ClientError, scopedSelection, type ModelScope } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  AgentLaunchOptions,
  WorkspaceId,
  type CommandPayload,
  type MessageContext,
  type PermissionMode,
  type WorktreeBase,
} from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { baseName, provisionalTitle } from "@ace/ui-core";
import { useCallback, useState } from "react";
import { rememberTitle } from "@/features/thread/index.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import {
  createAttemptKey,
  forgetCreateAttempt,
  readCreateAttempt,
  sameCreate,
  saveCreateAttempt,
} from "./create-attempt.ts";
import { useLayout } from "@/lib/layout.tsx";
import { dismissSend } from "@/lib/dismissed-sends.ts";
import { rememberProvider } from "@/lib/provider-statuses.ts";

export interface CreateRequest {
  project: string;
  /** The account the thread runs on: picked first, before its model. */
  scope: ModelScope;
  /** The catalog id listed on that account (OpenCode's `provider/model`), never a bare native id. */
  model: string;
  mode: "local" | "worktree";
  /** Where a worktree starts, a local or a remote branch; ignored for the local checkout. */
  base: WorktreeBase | undefined;
  effort: string | undefined;
  /** The faster tier to run on (`serviceTier`), when the person turned speed on. */
  serviceTier?: string | undefined;
  /** An explicit approval mode for this thread; the daemon's default when omitted. */
  permission?: PermissionMode | undefined;
  text: string;
  input?: import("@ace/protocol").ContentPart[] | undefined;
  context?: MessageContext | undefined;
}

type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;

/**
 * The `thread.create` command for a request: the account's provider, account (or ACP identity)
 * and catalog id, as `ModelClient` would select them. Pure, so it can be saved offline; the
 * daemon resolves the id again at admission.
 */
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
    ...scopedSelection(request.scope, request.model),
    mode: request.mode,
    // `baseBranch` names the same commit for a daemon that doesn't read `base` yet.
    ...(request.mode === "worktree" && request.base
      ? { base: request.base, baseBranch: baseName(request.base) }
      : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(request.permission ? { permissionMode: request.permission } : {}),
    input: request.input ?? [{ type: "text", text: request.text }],
    ...(request.context ? { context: request.context } : {}),
  };
}

/** Where a new thread shows until the daemon has started it: its command's own route. */
export const pendingThreadId = (commandId: string) => `pending:${commandId}`;

/**
 * Start a thread the way a message is sent (UX audit SY-2, SY-4): `thread.create` goes into the
 * client's durable outbox under a command id made here, and the thread opens after the local save on its
 * pending route (`/t/pending:<commandId>`) with the person's message as its first bubble. The
 * pending view moves to the real thread when the daemon's receipt names it. A lost worker
 * leaves an unresolved attempt under its original id; resubmission reconciles that attempt
 * before a new command can be allocated.
 */
export function useCreateThread(): {
  /** Resolves false when the composer must keep its draft, including uncertain worker delivery. */
  create(request: CreateRequest): Promise<boolean>;
  error: string | undefined;
} {
  const client = useClient();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const connection = useDaemonConnection();
  const host = useHostIdentity();
  const deviceId = connection.endpoint?.kind === "daemon" ? connection.endpoint.deviceId : "fake";
  const recoveryKey = createAttemptKey(connection.url, deviceId);
  const [error, setError] = useState<string>();

  const create = useCallback(
    async (request: CreateRequest) => {
      setError(undefined);
      const requested = createPayload(request);
      let commandId: string | undefined;
      let submitted = false;
      try {
        const previous = readCreateAttempt(storage, recoveryKey);
        const hostId =
          host?.hostId ?? (await client.request({ type: "host.identity" })).identity.hostId;
        if (previous && previous.hostId !== hostId) {
          setError(
            "The previous thread belongs to another daemon. Reconnect to that daemon to recover it.",
          );
          return false;
        }
        if (previous && !sameCreate(previous.payload, requested)) {
          setError(
            "The previous thread start still needs recovery. Restore that message and retry before starting another.",
          );
          return false;
        }
        const attempt = previous ?? {
          hostId,
          commandId: crypto.randomUUID(),
          payload: requested,
        };
        commandId = attempt.commandId;
        saveCreateAttempt(storage, recoveryKey, attempt);
        rememberTitle(commandId, provisionalTitle(attempt.payload.input));
        rememberProvider(storage, attempt.payload.provider);
        submitted = true;
        await client.enqueue(attempt.payload, commandId);
        // The outbox now owns the payload. Failure to remove a recovery record is safe:
        // a later submission still reconciles the same command rather than creating another.
        try {
          forgetCreateAttempt(storage, recoveryKey);
        } catch {
          /* Keep its original ID. */
        }
        void navigate({ to: "/t/$threadId", params: { threadId: pendingThreadId(commandId) } });
        return true;
      } catch (failure) {
        if (submitted && failure instanceof ClientError && failure.code === "offline") {
          setError(
            "Thread delivery is uncertain. Reconnect and send this message again to recover the same thread.",
          );
          return false;
        }
        if (submitted && commandId) {
          try {
            forgetCreateAttempt(storage, recoveryKey);
          } catch {
            /* Retry remains idempotent. */
          }
          dismissSend(storage, commandId);
        }
        setError("This device couldn't save the new thread. Try again.");
        return false;
      }
    },
    [client, navigate, storage, recoveryKey, host],
  );
  return { create, error };
}
