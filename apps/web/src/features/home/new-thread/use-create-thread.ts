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
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberTitle, sameSubmittedDraft, type SubmittedDraft } from "@/features/thread/index.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { withBrowserLock } from "@/boot/web-locks.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import {
  createAttemptKey,
  forgetCreateAttempt,
  readCreateAttempt,
  saveCreateAttempt,
} from "./create-attempt.ts";
import {
  differentCreateHost,
  settleCreateAttempt,
  useCreateRecovery,
} from "./use-create-recovery.ts";
import { useLayout } from "@/lib/layout.tsx";
import { dismissSend } from "@/lib/dismissed-sends.ts";
import { rememberProvider } from "@/lib/provider-statuses.ts";

export interface CreateRequest {
  project: string;
  /** The composer's own draft key, retained until the original create settles. */
  draftKey?: string | undefined;
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
export function useCreateThread(
  onRecovered: (payload: SubmittedDraft & { workspaceId: string }) => void,
  canNavigate?: (() => boolean) | undefined,
): {
  /** Resolves false when the composer must keep its draft, including uncertain worker delivery. */
  create(request: CreateRequest): Promise<boolean>;
  error: string | undefined;
  recovering: boolean;
} {
  const client = useClient();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const connection = useDaemonConnection();
  const host = useHostIdentity();
  const deviceId = connection.endpoint?.kind === "daemon" ? connection.endpoint.deviceId : "fake";
  const recoveryKey = createAttemptKey(connection.url, deviceId);
  const [error, setError] = useState<string>();

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const flight = useRef<{ payload: SubmittedDraft; promise: Promise<boolean> } | undefined>(
    undefined,
  );
  const recovery = useCreateRecovery({
    client,
    storage,
    key: recoveryKey,
    hostId: host?.hostId,
    isSubmitting: () => flight.current !== undefined,
    onError: setError,
    onRecovered,
    canNavigate,
  });

  const submit = useCallback(
    async (request: CreateRequest) => {
      setError(undefined);
      const requested = createPayload(request);
      let commandId: string | undefined;
      let submitted = false;
      try {
        const hostId =
          host?.hostId ?? (await client.request({ type: "host.identity" })).identity.hostId;
        const attempt = await withBrowserLock(recoveryKey, () => {
          const previous = readCreateAttempt(storage, recoveryKey);
          if (previous && previous.hostId !== hostId) {
            setError(differentCreateHost);
            return undefined;
          }
          const reserved = previous ?? {
            hostId,
            commandId: crypto.randomUUID(),
            draftKey: request.draftKey,
            payload: requested,
          };
          saveCreateAttempt(storage, recoveryKey, reserved);
          return reserved;
        });
        if (!attempt) return false;
        commandId = attempt.commandId;
        rememberTitle(commandId, provisionalTitle(attempt.payload.input));
        rememberProvider(storage, attempt.payload.provider);
        submitted = true;
        await client.enqueue(attempt.payload, commandId);
        // A local enqueue reply confirms persistence, not settlement. Keep the journal
        // until a receipt for this ID arrives, including after this page has unmounted.
        void settleCreateAttempt(client, storage, recoveryKey, attempt).catch(() => {
          /* Reconnect recovers the saved payload under its original ID. */
        });
        if (mounted.current && canNavigate?.() !== false)
          void navigate({ to: "/t/$threadId", params: { threadId: pendingThreadId(commandId) } });
        return sameSubmittedDraft(requested, attempt.payload);
      } catch (failure) {
        if (submitted && failure instanceof ClientError && failure.code === "offline") {
          setError(
            "Thread delivery is uncertain. Reconnect and send this message again to recover the same thread.",
          );
          return false;
        }
        if (submitted && commandId) {
          try {
            await withBrowserLock(recoveryKey, () => {
              if (commandId) forgetCreateAttempt(storage, recoveryKey, commandId);
            });
          } catch {
            /* Retry remains idempotent. */
          }
          dismissSend(storage, commandId);
        }
        setError("This device couldn't save the new thread. Try again.");
        return false;
      }
    },
    [client, navigate, storage, recoveryKey, host, canNavigate],
  );
  const create = useCallback(
    (request: CreateRequest) => {
      // Share the promise before any awaited identity or persistence work. A second Enter
      // cannot allocate another command while the first submission remains unresolved.
      if (recovery.isRecovering()) return Promise.resolve(false);
      const payload = createPayload(request);
      const current = flight.current;
      if (current)
        return current.promise.then((sent) => sent && sameSubmittedDraft(current.payload, payload));
      const pending = submit(request).finally(() => {
        if (flight.current?.promise === pending) flight.current = undefined;
      });
      flight.current = { payload, promise: pending };
      return pending;
    },
    [submit, recovery],
  );
  return { create, error, recovering: recovery.recovering };
}
