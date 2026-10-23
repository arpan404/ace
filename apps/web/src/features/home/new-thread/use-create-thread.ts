import { ClientError } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  createPayload,
  provisionalTitle,
  type CreatePayload,
  type CreateRequest,
} from "@ace/ui-core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  preloadPendingThread,
  rememberTitle,
  sameSubmittedDraft,
  type SubmittedDraft,
} from "@/features/thread/index.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { withBrowserLock } from "@/boot/web-locks.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import {
  createAttemptsKey,
  forgetCreateAttempt,
  readCreateAttempts,
  saveCreateAttempt,
  type CreateAttempt,
} from "./create-attempt.ts";
import {
  differentCreateHost,
  settleCreateAttempt,
  settlingFor,
  useCreateRecovery,
} from "./use-create-recovery.ts";
import { useLayout } from "@/lib/layout.tsx";
import { dismissSend } from "@/lib/dismissed-sends.ts";
import { rememberProvider } from "@/lib/provider-statuses.ts";

/** The request and its `thread.create` payload are shared with the native apps (`@ace/ui-core`). */
export { createPayload, type CreateRequest } from "@ace/ui-core";

/**
 * After the start is saved: `open` moves to the new thread (Enter); `stay` keeps New thread
 * open for the next one and says the thread started (the other send key, ⌘↵ by default).
 */
export type AfterCreate = "open" | "stay";

/** Where a new thread shows until the daemon has started it: its command's own route. */
export const pendingThreadId = (commandId: string) => `pending:${commandId}`;

/**
 * Start a thread the way a message is sent (UX audit SY-2, SY-4): `thread.create` goes into the
 * client's durable outbox under a command id made here, and the thread opens after the local save on its
 * pending route (`/t/pending:<commandId>`) with the person's message as its first bubble. The
 * pending view moves to the real thread when the daemon's receipt names it. Each start keeps
 * its own unresolved attempt, so another draft starts at once while the first is still being
 * made; a lost worker leaves the attempt under its original id, and sending the same draft
 * again reconciles that attempt instead of allocating another command.
 */
export function useCreateThread(
  onRecovered: (payload: SubmittedDraft & { workspaceId: string }) => void,
  canNavigate?: (() => boolean) | undefined,
  /** The composer's draft key: only its own recovered start opens its thread. */
  draftKey?: string | undefined,
  /** False when the person navigated here: a recovered start then never takes them away. */
  recoverStart = true,
  /** False when the composer is empty, so a recovered refusal is not reported. */
  holdsMessage?: () => boolean,
): {
  /** Resolves false when the composer must keep its draft, including uncertain worker delivery. */
  create(request: CreateRequest, after?: AfterCreate): Promise<boolean>;
  error: string | undefined;
  /** Clears the last start's problem once it no longer applies (the message was discarded). */
  dismissError(): void;
  /** A thread start not yet settled carries this draft scope, so no editor may resume it. */
  claims(draftId: string | undefined): boolean;
} {
  const client = useClient();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const connection = useDaemonConnection();
  const host = useHostIdentity();
  const deviceId = connection.endpoint?.kind === "daemon" ? connection.endpoint.deviceId : "fake";
  const recoveryKey = createAttemptsKey(connection.url, deviceId);
  const [error, setError] = useState<string>();

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The thread route and its pending view load with New thread, so Enter moves there in place.
  const router = useRouter();
  useEffect(() => {
    void preloadPendingThread().catch(() => {});
    void router.loadRouteChunk(router.routesById["/_home/t/$threadId"])?.catch(() => {});
  }, [router]);
  const flight = useRef<{ payload: SubmittedDraft; promise: Promise<boolean> } | undefined>(
    undefined,
  );
  useCreateRecovery({
    client,
    storage,
    key: recoveryKey,
    hostId: host?.hostId,
    draftKey,
    onError: setError,
    onRecovered,
    canNavigate: () => recoverStart && canNavigate?.() !== false,
    holdsMessage,
  });

  const submit = useCallback(
    async (request: CreateRequest, after: AfterCreate) => {
      setError(undefined);
      const requested = createPayload(request);
      let commandId: string | undefined;
      let submitted = false;
      try {
        const hostId =
          host?.hostId ?? (await client.request({ type: "host.identity" })).identity.hostId;
        const attempt = await withBrowserLock(recoveryKey, () => {
          // The same draft sent again (a lost worker, an uncertain delivery) reconciles its
          // original command; any other draft starts its own.
          const previous = readCreateAttempts(storage, recoveryKey).find((saved) =>
            resubmits(saved, request.draftKey, requested),
          );
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
        // Recovery leaves this start to the wait below.
        settlingFor(client).add(commandId);
        await client.enqueue(attempt.payload, commandId);
        // A local enqueue reply confirms persistence, not settlement. Keep the journal
        // until a receipt for this ID arrives, including after this page has unmounted.
        void settleCreateAttempt(client, storage, recoveryKey, attempt).catch(() => {
          /* Reconnect recovers the saved payload under its original ID. */
        });
        const threadId = pendingThreadId(commandId);
        // Staying put: the new row in the task list is the confirmation.
        if (after === "stay") return sameSubmittedDraft(requested, attempt.payload);
        // Its view drawn at once on arrival: no empty frame between New thread and the thread.
        await preloadPendingThread().catch(() => {});
        if (mounted.current && canNavigate?.() !== false)
          void navigate({ to: "/t/$threadId", params: { threadId } });
        return sameSubmittedDraft(requested, attempt.payload);
      } catch (failure) {
        if (commandId) settlingFor(client).delete(commandId);
        if (failure instanceof ClientError && failure.code === "busy" && !submitted) {
          setError(
            "Too many new threads are still starting on this device. Wait for one to start, then try again.",
          );
          return false;
        }
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
    (request: CreateRequest, after: AfterCreate = "open") => {
      // Share the promise before any awaited identity or persistence work. A second Enter
      // cannot allocate another command while the first submission is still being saved.
      const payload = createPayload(request);
      const current = flight.current;
      if (current)
        return current.promise.then((sent) => sent && sameSubmittedDraft(current.payload, payload));
      const pending = submit(request, after).finally(() => {
        if (flight.current?.promise === pending) flight.current = undefined;
      });
      flight.current = { payload, promise: pending };
      return pending;
    },
    [submit],
  );
  const claims = useCallback(
    (draftId: string | undefined) => {
      if (!draftId) return false;
      try {
        return readCreateAttempts(storage, recoveryKey).some(
          (attempt) => attempt.payload.context?.draftId === draftId,
        );
      } catch {
        return false;
      }
    },
    [storage, recoveryKey],
  );
  const dismissError = useCallback(() => setError(undefined), []);
  return { create, error, dismissError, claims };
}

/**
 * Whether sending `payload` from `draftKey` is the saved start sent again: the same composer,
 * the same draft scope (a new draft gets a new one) and the same words and files.
 */
function resubmits(
  saved: CreateAttempt,
  draftKey: string | undefined,
  payload: CreatePayload,
): boolean {
  return (
    saved.draftKey === draftKey &&
    saved.payload.workspaceId === payload.workspaceId &&
    saved.payload.context?.draftId === payload.context?.draftId &&
    sameSubmittedDraft(saved.payload, payload)
  );
}
