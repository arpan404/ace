import { ClientError, type ClientApi } from "@ace/client";
import { useConnectionState } from "@ace/client-react";
import type { CommandResult } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { withBrowserLock } from "@/boot/web-locks.ts";
import { discardSubmittedDraft, type SubmittedDraft } from "@/features/thread/index.ts";
import { forgetCreateAttempt, readCreateAttempt, type CreateAttempt } from "./create-attempt.ts";

export const differentCreateHost =
  "The previous thread belongs to another daemon. Reconnect to that daemon to recover it.";

/** Intent subscriptions can share a command without competing for its single SDK waiter. */
function createReceipt(
  client: ClientApi,
  attempt: CreateAttempt,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) return Promise.reject(new ClientError("aborted"));
  return new Promise((resolve, reject) => {
    const intent = client.intent(attempt.commandId);
    const connection = client.connectionState();
    const stops: (() => void)[] = [];
    let done = false;
    const finish = (receipt: CommandResult | undefined, error?: unknown) => {
      if (done) return;
      done = true;
      for (const stop of stops.splice(0)) stop();
      signal?.removeEventListener("abort", abort);
      if (receipt) resolve(receipt);
      else reject(error);
    };
    const abort = () => finish(undefined, new ClientError("aborted"));
    const check = () => {
      const receipt = intent.getSnapshot()?.result;
      if (receipt) finish(receipt);
      else if (connection.getSnapshot() === "fatal") finish(undefined, new ClientError("offline"));
    };
    try {
      stops.push(intent.subscribe(check));
      stops.push(connection.subscribe(check));
      signal?.addEventListener("abort", abort, { once: true });
      check();
    } catch (error) {
      finish(undefined, error);
    }
    // Reattach by ID even if admission already removed the outbox entry: a missing final
    // receipt still needs reconciliation. Cached receipts finish above without replay.
    if (!done)
      void client
        .enqueue(attempt.payload, attempt.commandId)
        .then(check, (error: unknown) => finish(undefined, error));
  });
}

/** Settlement is correlated by ID, never by whatever the composer currently selects. */
export async function settleCreateAttempt(
  client: ClientApi,
  storage: KeyValueStorage | undefined,
  key: string,
  attempt: CreateAttempt,
  signal?: AbortSignal,
) {
  const receipt = await createReceipt(client, attempt, signal);
  if (receipt.commandId !== attempt.commandId) throw new ClientError("protocol");
  const removed = await withBrowserLock(key, () => {
    if (signal?.aborted) throw new ClientError("aborted");
    if (readCreateAttempt(storage, key)?.commandId !== receipt.commandId) return false;
    if (receipt.ok)
      discardSubmittedDraft(
        storage,
        attempt.draftKey ?? `new:${attempt.payload.workspaceId}`,
        attempt.payload,
      );
    return forgetCreateAttempt(storage, key, receipt.commandId);
  });
  return removed ? receipt : undefined;
}

/** Recover the saved create even when catalog changes make its old selection unavailable. */
export function useCreateRecovery(options: {
  client: ClientApi;
  storage: KeyValueStorage | undefined;
  key: string;
  hostId: string | undefined;
  isSubmitting(): boolean;
  onError(message: string): void;
  onRecovered(payload: SubmittedDraft & { workspaceId: string }): void;
}): { recovering: boolean; isRecovering(): boolean } {
  const { client, storage, key, hostId } = options;
  const ready = useConnectionState() === "ready";
  const navigate = useNavigate();
  const [recovering, setRecovering] = useState(false);
  const running = useRef(false);
  const [revision, setRevision] = useState(0);
  const submitting = useEffectEvent(options.isSubmitting);
  const report = useEffectEvent(options.onError);
  const recovered = useEffectEvent(options.onRecovered);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === key) setRevision((value) => value + 1);
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const run = async () => {
      // No identity read is needed for an empty slot. After any await, re-read under the
      // lock so another window's newer record cannot be confused with this one.
      if (!ready || submitting() || !readCreateAttempt(storage, key)) return;
      running.current = true;
      setRecovering(true);
      const owner =
        hostId ??
        (await client.request({ type: "host.identity" }, { signal: controller.signal })).identity
          .hostId;
      const attempt = await withBrowserLock(key, () => readCreateAttempt(storage, key));
      if (!active || !attempt) return;
      if (attempt.hostId !== owner) {
        report(differentCreateHost);
        return;
      }
      const receipt = await settleCreateAttempt(client, storage, key, attempt, controller.signal);
      if (!active || !receipt) return;
      if (!receipt.ok) {
        report("The previous thread start was refused. You can edit this message and try again.");
        return;
      }
      recovered(attempt.payload);
      void navigate({
        to: "/t/$threadId",
        params: { threadId: receipt.threadId ?? `pending:${attempt.commandId}` },
      });
    };
    void run()
      .catch((error: unknown) => {
        if (!active || (error instanceof ClientError && error.code === "aborted")) return;
        report("Thread delivery is uncertain. Reconnect to recover the original thread start.");
      })
      .finally(() => {
        if (active) {
          running.current = false;
          setRecovering(false);
        }
      });
    return () => {
      active = false;
      running.current = false;
      controller.abort();
    };
    // Storage events invalidate the read even when every connection dependency is unchanged.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, storage, key, hostId, ready, revision, navigate]);
  return { recovering, isRecovering: () => running.current };
}
