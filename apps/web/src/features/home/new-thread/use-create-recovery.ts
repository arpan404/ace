import { ClientError, type ClientApi } from "@ace/client";
import { useConnectionState } from "@ace/client-react";
import type { CommandResult } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import { withBrowserLock } from "@/boot/web-locks.ts";
import { newThreadDraftKey } from "@/lib/new-thread-draft-key.ts";
import { discardSubmittedDraft, type SubmittedDraft } from "@/features/thread/index.ts";
import {
  createAttemptRecordKey,
  forgetCreateAttempt,
  readCreateAttempt,
  readCreateAttempts,
  type CreateAttempt,
} from "./create-attempt.ts";

export const differentCreateHost =
  "The previous thread belongs to another daemon. Reconnect to that daemon to recover it.";
const refusedStart =
  "The previous thread start was refused. You can edit this message and try again.";

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

/** The starts this window is already waiting on, per client, so recovery doesn't wait twice. */
const settling = new WeakMap<ClientApi, Set<string>>();
export function settlingFor(client: ClientApi): Set<string> {
  let ids = settling.get(client);
  if (!ids) {
    ids = new Set();
    settling.set(client, ids);
  }
  return ids;
}

/** Settlement is correlated by ID, never by whatever the composer currently selects. */
export async function settleCreateAttempt(
  client: ClientApi,
  storage: KeyValueStorage | undefined,
  indexKey: string,
  attempt: CreateAttempt,
  signal?: AbortSignal,
) {
  const waiting = settlingFor(client);
  waiting.add(attempt.commandId);
  try {
    const receipt = await createReceipt(client, attempt, signal);
    if (receipt.commandId !== attempt.commandId) throw new ClientError("protocol");
    const removed = await withBrowserLock(indexKey, () => {
      if (signal?.aborted) throw new ClientError("aborted");
      const recordKey = createAttemptRecordKey(indexKey, receipt.commandId);
      if (!readCreateAttempt(storage, recordKey)) return false;
      if (receipt.ok)
        discardSubmittedDraft(
          storage,
          attempt.draftKey ?? newThreadDraftKey(attempt.hostId, attempt.payload.workspaceId),
          attempt.payload,
        );
      return forgetCreateAttempt(storage, indexKey, receipt.commandId);
    });
    return removed ? receipt : undefined;
  } finally {
    waiting.delete(attempt.commandId);
  }
}

/**
 * Recover every saved start (a lost worker, a reload) even when catalog changes make its old
 * selection unavailable. Starts this window is already waiting on are left to that wait. Only a
 * start from this composer's draft (`draftKey`) opens its thread when it settles.
 */
export function useCreateRecovery(options: {
  client: ClientApi;
  storage: KeyValueStorage | undefined;
  key: string;
  hostId: string | undefined;
  draftKey: string | undefined;
  onError(message: string): void;
  onRecovered(payload: SubmittedDraft & { workspaceId: string }): void;
  canNavigate?: (() => boolean) | undefined;
  /** False when the composer is empty: a refusal then has no message left to edit. */
  holdsMessage?: (() => boolean) | undefined;
}): void {
  const { client, storage, key, hostId } = options;
  const ready = useConnectionState() === "ready";
  const navigate = useNavigate();
  const [revision, setRevision] = useState(0);
  const report = useEffectEvent(options.onError);
  const recovered = useEffectEvent(options.onRecovered);
  const ownDraft = useEffectEvent(
    (attempt: CreateAttempt) =>
      attempt.draftKey === undefined || attempt.draftKey === options.draftKey,
  );
  const navigationAllowed = useEffectEvent(() => options.canNavigate?.() ?? true);
  const holdsMessage = useEffectEvent(() => options.holdsMessage?.() ?? true);
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
    const failed = (error: unknown) => {
      if (!active || (error instanceof ClientError && error.code === "aborted")) return;
      report("Thread delivery is uncertain. Reconnect to recover the original thread start.");
    };
    const recover = async (attempt: CreateAttempt) => {
      const receipt = await settleCreateAttempt(client, storage, key, attempt, controller.signal);
      if (!active || !receipt) return;
      if (!receipt.ok) {
        if (ownDraft(attempt) && holdsMessage()) report(receipt.detail ?? refusedStart);
        return;
      }
      recovered(attempt.payload);
      if (!ownDraft(attempt) || !navigationAllowed()) return;
      void navigate({
        to: "/t/$threadId",
        params: { threadId: receipt.threadId ?? `pending:${attempt.commandId}` },
      });
    };
    const run = async () => {
      // No identity read is needed with nothing saved. After any await, re-read under the
      // lock so another window's newer records cannot be confused with these.
      if (!ready || !readCreateAttempts(storage, key).length) return;
      const owner =
        hostId ??
        (await client.request({ type: "host.identity" }, { signal: controller.signal })).identity
          .hostId;
      const attempts = await withBrowserLock(key, () => readCreateAttempts(storage, key));
      if (!active) return;
      const waiting = settlingFor(client);
      const open = attempts.filter((attempt) => !waiting.has(attempt.commandId));
      if (open.some((attempt) => attempt.hostId !== owner)) report(differentCreateHost);
      for (const attempt of open) if (attempt.hostId === owner) void recover(attempt).catch(failed);
    };
    void run().catch(failed);
    return () => {
      active = false;
      controller.abort();
    };
    // Storage events invalidate the read even when every connection dependency is unchanged.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, storage, key, hostId, ready, revision, navigate]);
}
