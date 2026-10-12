import type { StagedSend } from "./send-store.ts";

export const uploadTimeoutMs = 5 * 60_000;
export interface UploadClock {
  now(): number;
}
/** Browser wall-clock boundary; the composer supplies its injected UI clock. */
export const browserUploadClock: UploadClock = { now: () => Date.now() };
export function uploadClock(now: () => number): UploadClock {
  return { now };
}
export function uploadPending(send: Pick<StagedSend, "preparing" | "attachments">): boolean {
  return !!send.preparing || send.attachments.some((file) => !file.sha256);
}
/** An interrupted upload may be removed, never resumed or edited from another page. */
export function uploadIsInterrupted(
  send: StagedSend,
  uploaderPresent: boolean,
  now: number,
): boolean {
  return (
    !!send.uploadInterrupted ||
    (uploadPending(send) &&
      (!uploaderPresent ||
        send.uploadStartedAt === undefined ||
        now >= send.uploadStartedAt + uploadTimeoutMs))
  );
}
