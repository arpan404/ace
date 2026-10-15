import { ClientError, defaultLimits, fitsUtf8 } from "@ace/client";
import { CommandPayload, HostId } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

const Attempt = z.object({
  hostId: HostId,
  commandId: z.string().min(1),
  draftKey: z.string().optional(),
  payload: CommandPayload,
});
export type CreateAttempt = {
  hostId: string;
  commandId: string;
  draftKey?: string | undefined;
  payload: Extract<CommandPayload, { type: "thread.create" }>;
};

/*
 * Thread starts not yet settled by the daemon's receipt, kept per endpoint/device so a lost
 * worker or a reload recovers each under its original command id. Every start has its own
 * record (`createAttemptRecordKey`) and the endpoint's index (`createAttemptsKey`) lists them,
 * so a second thread can start while the first is still being made. Writers hold the index's
 * browser lock.
 */

/** At most this many starts wait for their receipts on one device. */
export const maxCreateAttempts = 8;

const Index = z.array(z.string().min(1)).max(maxCreateAttempts);

/** The endpoint/device's index of unsettled starts; also the lock every writer holds. */
export function createAttemptsKey(url: string, deviceId: string): string {
  return `ace.createAttempts:${JSON.stringify([url, deviceId])}`;
}
/** One start's own record. */
export function createAttemptRecordKey(indexKey: string, commandId: string): string {
  return `ace.createAttempt:${JSON.stringify([indexKey, commandId])}`;
}

function readIndex(storage: KeyValueStorage, indexKey: string): string[] {
  const raw = storage.getItem(indexKey);
  if (raw === null || raw === "") return [];
  return Index.parse(JSON.parse(raw));
}
function writeIndex(storage: KeyValueStorage, indexKey: string, ids: readonly string[]): void {
  if (ids.length) storage.setItem(indexKey, JSON.stringify(ids));
  else if (storage.removeItem) storage.removeItem(indexKey);
  else storage.setItem(indexKey, "");
}
function needStorage(storage: KeyValueStorage | undefined): KeyValueStorage {
  if (!storage)
    throw new ClientError("storage", "This device cannot retain a thread start for recovery.");
  return storage;
}

/** One start by its record key; undefined once it has settled. */
export function readCreateAttempt(
  storage: KeyValueStorage | undefined,
  recordKey: string,
): CreateAttempt | undefined {
  const raw = needStorage(storage).getItem(recordKey);
  if (raw === null || raw === "") return undefined;
  const attempt = Attempt.parse(JSON.parse(raw));
  if (attempt.payload.type !== "thread.create") throw new ClientError("storage");
  return {
    hostId: attempt.hostId,
    commandId: attempt.commandId,
    draftKey: attempt.draftKey,
    payload: attempt.payload,
  };
}

/** Every unsettled start on this endpoint/device, oldest first. */
export function readCreateAttempts(
  storage: KeyValueStorage | undefined,
  indexKey: string,
): CreateAttempt[] {
  const kept = needStorage(storage);
  return readIndex(kept, indexKey).flatMap((id) => {
    const attempt = readCreateAttempt(kept, createAttemptRecordKey(indexKey, id));
    return attempt ? [attempt] : [];
  });
}

/** Keep a start until its receipt; refused with `busy` when too many already wait. */
export function saveCreateAttempt(
  storage: KeyValueStorage | undefined,
  indexKey: string,
  attempt: CreateAttempt,
): void {
  const kept = needStorage(storage);
  const json = JSON.stringify(attempt);
  if (!fitsUtf8(json, defaultLimits.sendBytes)) throw new ClientError("limit");
  const ids = readIndex(kept, indexKey);
  const listed = ids.includes(attempt.commandId);
  if (!listed && ids.length >= maxCreateAttempts) throw new ClientError("busy");
  kept.setItem(createAttemptRecordKey(indexKey, attempt.commandId), json);
  if (!listed) writeIndex(kept, indexKey, [...ids, attempt.commandId]);
}

/** Forget a settled start; false when it was already forgotten. */
export function forgetCreateAttempt(
  storage: KeyValueStorage | undefined,
  indexKey: string,
  commandId: string,
): boolean {
  const kept = needStorage(storage);
  const recordKey = createAttemptRecordKey(indexKey, commandId);
  const ids = readIndex(kept, indexKey);
  const present = readCreateAttempt(kept, recordKey) !== undefined;
  if (kept.removeItem) kept.removeItem(recordKey);
  else kept.setItem(recordKey, "");
  if (ids.includes(commandId))
    writeIndex(
      kept,
      indexKey,
      ids.filter((id) => id !== commandId),
    );
  return present;
}
