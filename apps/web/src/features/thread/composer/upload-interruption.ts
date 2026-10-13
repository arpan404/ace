import type { StagedSend } from "./send-store.ts";

/*
 * Who may act on a message held for its uploads (issue #580). Pure: the page, its clock and
 * whether it still holds the files are passed in.
 *
 * - The page that staged or claimed a message owns it (`owner`). Ownership is a lease: it runs
 *   from `uploadStartedAt` for `uploadTimeoutMs`. A page releases it when it closes or reloads
 *   (`releaseUpload`); a crashed page's lease simply runs out. Nothing depends on Web Locks.
 * - While another page's lease runs, the message is live there: this page shows it uploading
 *   and offers nothing. Once released or expired it is interrupted, and any page may claim it.
 * - Every claim, release and removal moves `fence` on. An upload or recovery acts only while
 *   the record still carries its page and fence (`holdsUpload`), so a late upload callback or a
 *   losing competitor can never settle, send or delete what someone else now owns.
 * - Removal is terminal (`removing`): nobody can claim a message that is being removed.
 */

export const uploadTimeoutMs = 5 * 60_000;
export interface UploadClock {
  now(): number;
}
/** Browser wall-clock boundary; the composer supplies its injected UI clock. */
export const browserUploadClock: UploadClock = { now: () => Date.now() };
export function uploadClock(now: () => number): UploadClock {
  return { now };
}

/** What this page knows when it judges a held message. */
export interface UploadHere {
  page: string;
  /** This page still holds the message's files (it staged or adopted them, and hasn't reloaded). */
  holdsFiles: boolean;
  now: number;
}

/** The ownership an upload or a recovery started under. */
export interface UploadToken {
  page: string;
  fence: number;
}

type Held = Pick<
  StagedSend,
  | "preparing"
  | "attachments"
  | "owner"
  | "fence"
  | "uploadStartedAt"
  | "uploadInterrupted"
  | "removing"
  | "failed"
>;

export function uploadPending(send: Pick<StagedSend, "preparing" | "attachments">): boolean {
  return !!send.preparing || send.attachments.some((file) => !file.sha256);
}

/** The work under way stopped: its page closed, reloaded, crashed or outlived its lease. */
export function uploadIsInterrupted(send: Held, here: UploadHere): boolean {
  if (send.removing || send.uploadInterrupted) return true;
  if (!uploadPending(send)) return false;
  if (send.uploadStartedAt === undefined || here.now >= send.uploadStartedAt + uploadTimeoutMs)
    return true;
  if (send.owner === here.page) return !here.holdsFiles;
  return send.owner === undefined;
}

/** Retry, Edit or Remove may act on it: it failed or stopped, and nobody is working on it. */
export function uploadRecoverable(send: Held, here: UploadHere): boolean {
  if (send.removing) return false;
  return uploadIsInterrupted(send, here) || (!!send.failed && !send.preparing);
}

export const stoppedReason = "The upload stopped before it finished";

/**
 * This page takes the message over under a fresh lease; undefined when it isn't free to take.
 * It still reads as not sent, with why, until the recovery itself says otherwise.
 */
export function claimUpload<T extends Held>(send: T, here: UploadHere): T | undefined {
  if (!uploadRecoverable(send, here)) return undefined;
  return {
    ...send,
    owner: here.page,
    fence: (send.fence ?? 0) + 1,
    preparing: true,
    uploadStartedAt: here.now,
    uploadInterrupted: undefined,
    failed: send.failed ?? stoppedReason,
  };
}

/** The page is going away: what it was uploading becomes free for others at once. */
export function releaseUpload<T extends Held>(send: T, page: string): T | undefined {
  if (send.owner !== page || send.removing || !uploadPending(send)) return undefined;
  return { ...send, owner: undefined, fence: (send.fence ?? 0) + 1 };
}

/** Removal starts: no claim, upload or send can take the message back from here on. */
export function startRemoval<T extends Held>(send: T, here: UploadHere): T | undefined {
  if (send.removing) return send;
  if (!uploadIsInterrupted(send, here) && !(send.failed && !send.preparing)) return undefined;
  return { ...send, removing: true, fence: (send.fence ?? 0) + 1 };
}

/** The upload or recovery that started under `token` still owns the message. */
export function holdsUpload(send: Held, token: UploadToken): boolean {
  return !send.removing && send.owner === token.page && (send.fence ?? 0) === token.fence;
}
