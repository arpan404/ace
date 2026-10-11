import { ClientError, defaultLimits, fitsUtf8 } from "@ace/client";
import { CommandPayload, HostId } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

const Attempt = z.object({
  hostId: HostId,
  commandId: z.string().min(1),
  payload: CommandPayload,
});
export type CreateAttempt = {
  hostId: string;
  commandId: string;
  payload: Extract<CommandPayload, { type: "thread.create" }>;
};

/** One unresolved create per endpoint/device, independent of worker lifetime and token renewal. */
export function createAttemptKey(url: string, deviceId: string): string {
  return `ace.createAttempt:${JSON.stringify([url, deviceId])}`;
}
export function readCreateAttempt(
  storage: KeyValueStorage | undefined,
  key: string,
): CreateAttempt | undefined {
  if (!storage)
    throw new ClientError("storage", "This device cannot retain a thread start for recovery.");
  const raw = storage.getItem(key);
  if (raw === null || raw === "") return undefined;
  const attempt = Attempt.parse(JSON.parse(raw));
  if (attempt.payload.type !== "thread.create") throw new ClientError("storage");
  return { hostId: attempt.hostId, commandId: attempt.commandId, payload: attempt.payload };
}
export function saveCreateAttempt(
  storage: KeyValueStorage | undefined,
  key: string,
  attempt: CreateAttempt,
): void {
  if (!storage) throw new ClientError("storage");
  const json = JSON.stringify(attempt);
  if (!fitsUtf8(json, defaultLimits.sendBytes)) throw new ClientError("limit");
  storage.setItem(key, json);
}
export function forgetCreateAttempt(storage: KeyValueStorage | undefined, key: string): void {
  if (storage?.removeItem) storage.removeItem(key);
  else storage?.setItem(key, "");
}
const comparable = (payload: CreateAttempt["payload"]) =>
  JSON.stringify(
    CommandPayload.parse({
      ...payload,
      context: payload.context && { ...payload.context, draftId: undefined },
    }),
  );
/** A remount receives a fresh draft scope; the original command must retain its old payload. */
export function sameCreate(a: CreateAttempt["payload"], b: CreateAttempt["payload"]): boolean {
  return comparable(a) === comparable(b);
}
